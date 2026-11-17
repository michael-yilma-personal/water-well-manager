"""The one place an e2e suite learns where to connect.

Every suite under e2e/ starts with `import _target`. Importing this module
performs the checks below, so a suite cannot reach the network without them.

Configuration (all three are required):

    DRILL_E2E_SUPABASE_URL      bare project URL, scheme and host only
    DRILL_E2E_PUBLISHABLE_KEY   that project's publishable (anon) key
    DRILL_E2E_PASSWORD          the password shared by the test accounts

Each is read from the environment first; a name that is unset or empty there
is read from the git-ignored file `.env.e2e` at the repository root, which
holds the same names as KEY=value lines (see `_read_env_file`).

The module REFUSES - one line on stderr, exit code 2 - when:

  - any of the three values is missing;
  - the URL is not a bare http(s) project URL;
  - PROD_REF cannot be read from scripts/hooks/guard.conf;
  - the URL's project ref (its first host label) is PROD_REF, or PROD_REF
    appears anywhere in the URL.

There is no flag, argument or variable that turns a refusal off.

DRILL_E2E_ROOT exists for e2e/target_selftest.py only. It moves where
`.env.e2e` and guard.conf are looked up, so the self-test can exercise the
refusals with temporary files. It cannot weaken the production check: the
guard.conf of the repository this file lives in is always read as well, and a
URL naming either PROD_REF is refused.

Browser suites call `start_app()` for the address of the app under test; see
its docstring. Device suites go through `require_device_build()`.

What a suite may use: URL, KEY, REF, PASSWORD, the account emails (DRILLER1,
DRILLER2, ADMIN1, DATALOGGER1, SUPERVISOR1, ACCOUNTS), OUT, start_app(),
stop_app(), require_device_build().
"""
import atexit
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ENV_URL = 'DRILL_E2E_SUPABASE_URL'
ENV_KEY = 'DRILL_E2E_PUBLISHABLE_KEY'
ENV_PASSWORD = 'DRILL_E2E_PASSWORD'
ENV_ROOT = 'DRILL_E2E_ROOT'
ENV_APP_PORT = 'DRILL_E2E_APP_PORT'
ENV_APK_TARGET_REF = 'DRILL_E2E_APK_TARGET_REF'

ENV_FILE_NAME = '.env.e2e'
GUARD_CONF = os.path.join('scripts', 'hooks', 'guard.conf')
DEFAULT_APP_PORT = 3100

# The repository this file lives in. The app under test is always started from
# here and its guard.conf is always honoured, whatever DRILL_E2E_ROOT says.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def refuse(reason):
    """Print one line to stderr and exit with code 2."""
    line = ' '.join(str(reason).split())
    sys.stderr.write(f'_target: refusing to run: {line}\n')
    sys.stderr.flush()
    sys.exit(2)


# --------------------------------------------------------------------------
# reading the configuration
# --------------------------------------------------------------------------

def _read_env_file(path):
    """Parse KEY=value lines. Blank lines and lines starting with '#' are
    skipped; an optional leading `export ` is dropped; one pair of matching
    quotes around the value is removed. There are no inline comments, because
    a password may contain '#'. A missing file is an empty file."""
    values = {}
    try:
        with open(path, encoding='utf-8') as f:
            lines = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        if line.startswith('export '):
            line = line[len('export '):].lstrip()
        name, _, value = line.partition('=')
        name, value = name.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '\'"':
            value = value[1:-1]
        values[name] = value
    return values


def _read_prod_ref(root):
    """PROD_REF from <root>/scripts/hooks/guard.conf, or refuse.

    Same grammar as the guard hook: KEY=value lines; '#' starts a comment at
    the start of a line or after blanks following a value. The ref must be a
    plain word (letters, digits, - and _)."""
    path = os.path.join(root, GUARD_CONF)
    try:
        with open(path, encoding='utf-8') as f:
            lines = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        refuse(f'cannot read PROD_REF: {path} is missing or unreadable')
    found = None
    for raw in lines:
        line = raw.strip()
        if line.startswith('#') or not line.startswith('PROD_REF='):
            continue
        found = re.split(r'\s+#', line[len('PROD_REF='):], maxsplit=1)[0].strip()
    if not found:
        refuse(f'cannot read PROD_REF: {path} has no PROD_REF value')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', found):
        refuse(f'cannot read PROD_REF: the value in {path} is not a plain word')
    return found


def _project_ref(url):
    """The first host label of a bare http(s) URL, lower-cased, or refuse."""
    try:
        parts = urllib.parse.urlsplit(url)
        host = (parts.hostname or '').rstrip('.').lower()
        port = parts.port  # raises ValueError on a malformed port
    except ValueError:
        refuse(f'{ENV_URL} is not a valid URL')
    del port
    if parts.scheme.lower() not in ('http', 'https') or not host:
        refuse(f'{ENV_URL} must be an http(s) project URL')
    if parts.username is not None or parts.password is not None:
        refuse(f'{ENV_URL} must not carry credentials')
    if parts.path not in ('', '/') or parts.query or parts.fragment:
        refuse(f'{ENV_URL} must be the bare project URL: scheme and host, no path or query')
    if not re.fullmatch(r'[a-z0-9.-]+', host):
        refuse(f'{ENV_URL} has a host that is not a plain name')
    return host.split('.')[0]


_config_root = os.path.abspath(os.environ.get(ENV_ROOT) or REPO_ROOT)

# Production is named by the repository's own guard.conf, and by the one under
# DRILL_E2E_ROOT when that points somewhere else. Both must be readable.
_prod_refs = {_read_prod_ref(REPO_ROOT).lower()}
if os.path.realpath(_config_root) != os.path.realpath(REPO_ROOT):
    _prod_refs.add(_read_prod_ref(_config_root).lower())

_file_values = _read_env_file(os.path.join(_config_root, ENV_FILE_NAME))


def _setting(name):
    return (os.environ.get(name) or '').strip() or (_file_values.get(name) or '').strip()


_missing = [n for n in (ENV_URL, ENV_KEY, ENV_PASSWORD) if not _setting(n)]
if _missing:
    refuse('missing ' + ', '.join(_missing)
           + f' (set in the environment or in {ENV_FILE_NAME} at the repository root)')

URL = _setting(ENV_URL).rstrip('/')
KEY = _setting(ENV_KEY)
PASSWORD = _setting(ENV_PASSWORD)
REF = _project_ref(URL)

if REF in _prod_refs or any(ref in URL.lower() for ref in _prod_refs):
    refuse(f'{ENV_URL} names the production project (PROD_REF in {GUARD_CONF});'
           ' tests never run against production')

# The test accounts. They exist only in the tested project, never in production.
DRILLER1 = 'driller1@example.com'
DRILLER2 = 'driller2@example.com'
ADMIN1 = 'admin1@example.com'
DATALOGGER1 = 'datalogger1@example.com'
SUPERVISOR1 = 'supervisor1@example.com'
ACCOUNTS = (DRILLER1, DRILLER2, ADMIN1, DATALOGGER1, SUPERVISOR1)

# Where suites drop screenshots.
OUT = os.environ.get('E2E_OUT') or tempfile.gettempdir()


def production_source_problem(text, what, require_target=False):
    """Why `text` (source served to the app under test) is not acceptable, or
    None. It must not mention production; with require_target it must also
    carry the target URL."""
    lowered = text.lower()
    if any(ref in lowered for ref in _prod_refs):
        return f'{what} carries the production project ref'
    if require_target and URL.lower() not in lowered:
        return f'{what} does not carry the target project URL'
    return None


# --------------------------------------------------------------------------
# the app under test (browser suites)
# --------------------------------------------------------------------------

_app_proc = None
_app_url = None
_local = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _app_port():
    raw = (os.environ.get(ENV_APP_PORT) or '').strip()
    if not raw:
        return DEFAULT_APP_PORT
    if not raw.isdigit() or not 1024 <= int(raw) <= 65535:
        refuse(f'{ENV_APP_PORT} must be a port number between 1024 and 65535')
    return int(raw)


def _port_open(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0


def _fetch(url):
    """(status, body text) from the local dev server; (None, '') if it does
    not answer."""
    try:
        with _local.open(url, timeout=10) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, ''
    except (OSError, ValueError):
        return None, ''


def _modules_reading_the_target():
    """Source files of the app that read VITE_SUPABASE_URL, as paths relative
    to the repository root with forward slashes."""
    found = []
    src = os.path.join(REPO_ROOT, 'src')
    for folder, _dirs, names in os.walk(src):
        for name in sorted(names):
            if not name.endswith(('.ts', '.tsx')) or '.test.' in name:
                continue
            path = os.path.join(folder, name)
            try:
                with open(path, encoding='utf-8') as f:
                    if 'VITE_SUPABASE_URL' in f.read():
                        found.append(os.path.relpath(path, REPO_ROOT).replace(os.sep, '/'))
            except (OSError, UnicodeDecodeError):
                continue
    return sorted(found)


def stop_app():
    """Stop the server started by start_app(). Safe to call more than once."""
    global _app_proc, _app_url
    proc, _app_proc, _app_url = _app_proc, None, None
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            proc.kill()


def _on_signal(signum, _frame):
    stop_app()
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def start_app():
    """Start the app under test and return its base URL (no trailing slash).

    Runs `npx vite --port <port> --strictPort --host 127.0.0.1` from the
    repository root with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
    set from this module. Vite gives variables already in its environment
    priority over every .env file (loadEnv copies process.env last), so the
    repository's .env.local - production - is not what the app uses.

    That is then verified rather than assumed: the modules that read
    VITE_SUPABASE_URL are fetched from the running server, and unless they
    carry the target URL and no trace of the production ref, the server is
    stopped and the run refused (exit 2).

    The port is DRILL_E2E_APP_PORT, default 3100. A port that is already in
    use is refused: a suite never drives a server it did not start. The
    server is stopped at exit and on SIGTERM / SIGHUP. Calling this again in
    the same process returns the same URL.
    """
    global _app_proc, _app_url
    if _app_url is not None:
        return _app_url

    port = _app_port()
    if not os.path.exists(os.path.join(REPO_ROOT, 'node_modules', '.bin', 'vite')):
        refuse('vite is not installed in node_modules; run npm install first')
    if _port_open(port):
        refuse(f'port {port} is already in use; the suites start their own server'
               f' and never reuse one (free the port or set {ENV_APP_PORT})')

    env = dict(os.environ)
    env['VITE_SUPABASE_URL'] = URL
    env['VITE_SUPABASE_PUBLISHABLE_KEY'] = KEY
    _app_proc = subprocess.Popen(
        ['npx', 'vite', '--port', str(port), '--strictPort', '--host', '127.0.0.1'],
        cwd=REPO_ROOT, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    atexit.register(stop_app)
    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, _on_signal)

    base = f'http://127.0.0.1:{port}'
    answered = False
    for _ in range(240):
        if _app_proc.poll() is not None:
            stop_app()
            refuse(f'the Vite server exited before answering on port {port}')
        if _fetch(base + '/')[0] == 200:
            answered = True
            break
        time.sleep(0.5)
    if not answered:
        stop_app()
        refuse(f'the Vite server did not answer on port {port}')
    if _app_proc.poll() is not None:
        stop_app()
        refuse(f'port {port} is answered by a server this run did not start')

    modules = _modules_reading_the_target()
    if not modules:
        stop_app()
        refuse('cannot verify the app under test: no module under src/ reads VITE_SUPABASE_URL')
    carries_target = False
    for rel in modules:
        status, body = _fetch(f'{base}/{rel}')
        if status != 200:
            stop_app()
            refuse(f'cannot verify the app under test: the server did not serve {rel}')
        problem = production_source_problem(body, f'{rel} as served to the app under test')
        if problem:
            stop_app()
            refuse(problem)
        carries_target = carries_target or URL.lower() in body.lower()
    if not carries_target:
        stop_app()
        refuse('the app under test was not built for the target project:'
               ' no served module carries the target URL')

    _app_url = base
    return _app_url


# --------------------------------------------------------------------------
# device suites
# --------------------------------------------------------------------------

def require_device_build():
    """Refuse unless the operator has declared that the build installed on
    the device was made for the tested project.

    An APK has its project compiled in, so the suite cannot choose it. The
    declaration is DRILL_E2E_APK_TARGET_REF: the project ref the installed
    build was made for. It must equal REF, which is never production."""
    declared = (os.environ.get(ENV_APK_TARGET_REF) or '').strip().lower()
    if not declared:
        refuse('device suites need a build made for the tested project: build the APK with'
               ' VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY set to the target,'
               f' install it, then set {ENV_APK_TARGET_REF} to that project ref')
    if declared != REF:
        refuse(f'{ENV_APK_TARGET_REF} does not match the project in {ENV_URL};'
               ' the installed build and the suite must use the same project')
