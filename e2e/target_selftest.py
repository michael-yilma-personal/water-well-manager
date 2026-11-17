"""Self-test for e2e/_target.py and for the rule that no suite names a project.

Needs no database and no internet. It checks:

  1. _target refuses (exit 2, one line on stderr) when a value is missing,
     when the URL names production, and when PROD_REF cannot be read - and
     that nothing in the environment or on the command line turns that off;
  2. _target accepts a non-production project, from the environment and from
     .env.e2e, and exposes the URL, key, ref, password and accounts;
  3. the device gate refuses without a declared matching build;
  4. start_app() refuses a busy port, and - against a real Vite server on a
     free loopback port, with a made-up target - serves the app with the
     target's URL and without the production ref, whatever .env.local says;
  5. no file under e2e/ contains a project URL, project ref, key or password
     literal, and every suite takes its connection from _target.

_target is exercised in subprocesses with a controlled environment and a
temporary root (DRILL_E2E_ROOT) holding a guard.conf and .env.e2e. The strings
this file must forbid are assembled at run time, so the file passes its own
scan.

Run:  python3 e2e/target_selftest.py      (exit 0 only if every check passes)
"""
import ast
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

E2E = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(E2E)
GUARD = os.path.join('scripts', 'hooks', 'guard.conf')

N_URL = 'DRILL_E2E_SUPABASE_URL'
N_KEY = 'DRILL_E2E_PUBLISHABLE_KEY'
N_PW = 'DRILL_E2E_PASSWORD'
N_ROOT = 'DRILL_E2E_ROOT'
N_PORT = 'DRILL_E2E_APP_PORT'
N_APK = 'DRILL_E2E_APK_TARGET_REF'

HOST_TAIL = '.' + 'supa' + 'base' + '.co'
FAKE_PROD = 'fakeprodref' + '0' * 9
FAKE_STAGING = 'fakestagingref' + '1' * 6
FAKE_KEY = 'fake-key-' + uuid.uuid4().hex
FAKE_SECRET = uuid.uuid4().hex
# SHA-256 digests of values that must never reappear under e2e/. Only the
# digests are kept here: this file neither holds nor rebuilds the values.
NEVER_AGAIN = frozenset({
    '724936cd9b665b34b178904d938970b9fffede7f6fcbae3e0f61b87170c06feb',
})
QUOTED = re.compile(r'''(['"])((?:(?!\1)[^\n]){6,64})\1''')
BARE = re.compile(r'(?<!\S)\S{6,64}(?!\S)')


def reappearing(text, digests=NEVER_AGAIN):
    """Line numbers in `text` holding a quoted string literal or a
    whitespace-delimited token, 6 to 64 characters long, whose SHA-256 digest
    is in `digests`."""
    lines = set()
    for pattern, group in ((QUOTED, 2), (BARE, 0)):
        for m in pattern.finditer(text):
            token = m.group(group)
            if hashlib.sha256(token.encode('utf-8')).hexdigest() in digests:
                lines.add(text.count(chr(10), 0, m.start()) + 1)
    return sorted(lines)


def url_for(ref):
    return 'https://' + ref + HOST_TAIL


def url_with_login(user, secret, ref):
    """A URL carrying inline credentials, assembled here so that this file
    holds no such URL as a literal."""
    return 'https://' + user + ':' + secret + '@' + ref + HOST_TAIL


results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


def section(title):
    print(f'\n=== {title} ===')


# --------------------------------------------------------------------------
# running _target under control
# --------------------------------------------------------------------------

_roots = []


def make_root(guard=f'PROD_REF={FAKE_PROD}\nSTAGING_REF=\n', env_file=None):
    """A temporary root. `guard` None means no guard.conf at all; bytes are
    written as they are."""
    root = tempfile.mkdtemp(prefix='drill-e2e-selftest-')
    _roots.append(root)
    if guard is not None:
        os.makedirs(os.path.join(root, os.path.dirname(GUARD)))
        with open(os.path.join(root, GUARD), 'wb') as f:
            f.write(guard if isinstance(guard, bytes) else guard.encode())
    if env_file is not None:
        with open(os.path.join(root, '.env.e2e'), 'wb') as f:
            f.write(env_file if isinstance(env_file, bytes) else env_file.encode())
    return root


GOOD = {N_URL: url_for(FAKE_STAGING), N_KEY: FAKE_KEY, N_PW: FAKE_SECRET}
SHOW = ('import _target, json; print(json.dumps({"url": _target.URL, "key": _target.KEY,'
        ' "ref": _target.REF, "pw": _target.PASSWORD, "accounts": list(_target.ACCOUNTS)}))')


def run(env, root=None, code=SHOW, args=(), timeout=60):
    """Import _target in a fresh interpreter whose environment holds only
    what is passed here (plus PATH and HOME)."""
    child = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR') if k in os.environ}
    child['PYTHONDONTWRITEBYTECODE'] = '1'
    child[N_ROOT] = root if root is not None else make_root()
    child.update(env)
    try:
        p = subprocess.run([sys.executable, '-c', code, *args], cwd=E2E, env=child,
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, '', f'no result within {timeout} s'
    return p.returncode, p.stdout, p.stderr


def refused(name, result, mentions=None):
    rc, out, err = result
    lines = [l for l in err.splitlines() if l.strip()]
    ok = rc == 2 and len(lines) == 1 and out == ''
    if ok and mentions:
        ok = mentions.lower() in err.lower()
    check(name, ok, '' if ok else f'exit {rc}, stdout {out[:60]!r}, stderr {err[-200:]!r}')


def accepted(name, result, expect=None):
    rc, out, err = result
    ok = rc == 0
    detail = ''
    if ok and expect:
        try:
            got = json.loads(out)
            ok = all(got.get(k) == v for k, v in expect.items())
            detail = '' if ok else f'got {got}'
        except ValueError:
            ok, detail = False, f'stdout {out[:120]!r}'
    elif not ok:
        detail = f'exit {rc}, stderr {err[-200:]!r}'
    check(name, ok, detail)


def read_conf(name):
    """A value from the repository's real guard.conf, or None."""
    try:
        with open(os.path.join(REPO, GUARD), encoding='utf-8') as f:
            for raw in f.read().splitlines():
                line = raw.strip()
                if line.startswith(name + '='):
                    return re.split(r'\s+#', line[len(name) + 1:], maxsplit=1)[0].strip()
    except OSError:
        pass
    return None


REAL_PROD = read_conf('PROD_REF')
REAL_STAGING = read_conf('STAGING_REF')

# --------------------------------------------------------------------------
section('1. acceptance: a project that is not production')

accepted('accepts a non-production project given in the environment', run(GOOD),
         {'url': url_for(FAKE_STAGING), 'key': FAKE_KEY, 'ref': FAKE_STAGING, 'pw': FAKE_SECRET})
accepted('exposes the five test accounts', run(GOOD), {'accounts': [
    'driller1@example.com', 'driller2@example.com', 'admin1@example.com',
    'datalogger1@example.com', 'supervisor1@example.com']})

file_text = ''.join(f'{k}={v}\n' for k, v in GOOD.items())
accepted('falls back to .env.e2e when the environment is empty',
         run({}, make_root(env_file=file_text)),
         {'url': url_for(FAKE_STAGING), 'key': FAKE_KEY, 'ref': FAKE_STAGING, 'pw': FAKE_SECRET})

tricky = 'a#b=c ' + FAKE_SECRET
quoted = (f'# a comment\n\nexport {N_URL}="{url_for(FAKE_STAGING)}/"\n'
          f"{N_KEY} = '{FAKE_KEY}'\n{N_PW}={tricky}\nnot a pair\n")
accepted('.env.e2e: comments, export, quotes, and a secret containing # and =',
         run({}, make_root(env_file=quoted)),
         {'url': url_for(FAKE_STAGING), 'key': FAKE_KEY, 'pw': tricky})

accepted('an empty variable in the environment falls back to the file',
         run({N_URL: '', N_KEY: '  '}, make_root(env_file=file_text)),
         {'url': url_for(FAKE_STAGING), 'key': FAKE_KEY})

prod_file = file_text.replace(FAKE_STAGING, FAKE_PROD)
accepted('the environment wins over .env.e2e (file names production, environment does not)',
         run(GOOD, make_root(env_file=prod_file)), {'ref': FAKE_STAGING})
refused('the environment wins over .env.e2e (environment names production, file does not)',
        run({N_URL: url_for(FAKE_PROD)}, make_root(env_file=file_text)), 'production')

accepted('a trailing slash on the URL is tolerated and removed',
         run({**GOOD, N_URL: url_for(FAKE_STAGING) + '/'}), {'url': url_for(FAKE_STAGING)})
accepted('a comment after PROD_REF in guard.conf is not part of the ref',
         run(GOOD, make_root(guard=f'# head\nPROD_REF={FAKE_PROD}   # the live one\n')),
         {'ref': FAKE_STAGING})

# --------------------------------------------------------------------------
section('2. refusal: a value is missing')

for name in (N_URL, N_KEY, N_PW):
    env = {k: v for k, v in GOOD.items() if k != name}
    refused(f'refuses when {name} is missing', run(env), name)
    refused(f'refuses when {name} is blank', run({**GOOD, name: '   '}), name)
refused('refuses when nothing is configured at all', run({}), N_URL)
refused('refuses when .env.e2e is not text', run({}, make_root(env_file=b'\xff\xfe\x00\x01' * 64)))
refused('refuses when .env.e2e holds the names but no values',
        run({}, make_root(env_file=f'{N_URL}=\n{N_KEY}=""\n{N_PW}=\n')))
rc, out, err = run({N_URL: GOOD[N_URL], N_KEY: GOOD[N_KEY]})
check('the refusal does not print the key', FAKE_KEY not in err + out, err[-120:])

# --------------------------------------------------------------------------
section('3. refusal: the URL names production')

refused('refuses the production project URL', run({**GOOD, N_URL: url_for(FAKE_PROD)}), 'production')
for label, value in [
    ('with a trailing slash', url_for(FAKE_PROD) + '/'),
    ('in upper case', url_for(FAKE_PROD).upper()),
    ('with an explicit port', url_for(FAKE_PROD) + ':443'),
    ('with a trailing dot on the host', url_for(FAKE_PROD) + '.'),
    ('over plain http', 'http://' + FAKE_PROD + HOST_TAIL),
    ('with surrounding blanks', '  ' + url_for(FAKE_PROD) + '  '),
    ('with credentials in front', url_with_login('user', 'x', FAKE_PROD)),
    ('with a path', url_for(FAKE_PROD) + '/rest/v1'),
    ('as a sub-label of another host', 'https://proxy.' + FAKE_PROD + HOST_TAIL),
    ('hidden in a query', url_for(FAKE_STAGING) + '?to=' + FAKE_PROD),
    ('hidden in the credentials', 'https://' + FAKE_PROD + '@' + FAKE_STAGING + HOST_TAIL),
]:
    refused(f'refuses production {label}', run({**GOOD, N_URL: value}))
refused('refuses production named only in .env.e2e',
        run({}, make_root(env_file=prod_file)), 'production')
refused('refuses production when PROD_REF carries a trailing comment',
        run({**GOOD, N_URL: url_for(FAKE_PROD)},
            make_root(guard=f'PROD_REF={FAKE_PROD}\t# live\n')), 'production')
refused('refuses production when PROD_REF is written in another letter case',
        run({**GOOD, N_URL: url_for(FAKE_PROD)}, make_root(guard=f'PROD_REF={FAKE_PROD.upper()}\n')))

for label, value in [
    ('no scheme', FAKE_STAGING + HOST_TAIL),
    ('not a URL', 'staging please'),
    ('a file URL', 'file:///etc/hosts'),
    ('a URL with a path', url_for(FAKE_STAGING) + '/rest/v1'),
    ('a URL with a query', url_for(FAKE_STAGING) + '?x=1'),
    ('a URL with credentials', url_with_login('u', 'p', FAKE_STAGING)),
    ('a malformed port', url_for(FAKE_STAGING) + ':notaport'),
    ('a host with odd characters', 'https://sta ging' + HOST_TAIL),
]:
    refused(f'refuses a target that is {label}', run({**GOOD, N_URL: value}))

check('the repository guard.conf names a production ref', bool(REAL_PROD))
if REAL_PROD:
    refused('refuses the REAL production project',
            run({**GOOD, N_URL: url_for(REAL_PROD)}, REPO), 'production')
    refused('DRILL_E2E_ROOT cannot hide the real production ref behind another guard.conf',
            run({**GOOD, N_URL: url_for(REAL_PROD)}), 'production')

# --------------------------------------------------------------------------
section('4. refusal: PROD_REF cannot be read')

for label, guard in [
    ('guard.conf is missing', None),
    ('guard.conf is empty', ''),
    ('PROD_REF is empty', 'PROD_REF=\nSTAGING_REF=\n'),
    ('PROD_REF is only blanks and a comment', 'PROD_REF=   # none yet\n'),
    ('the PROD_REF line is commented out', f'# PROD_REF={FAKE_PROD}\n'),
    ('only STAGING_REF is set', f'STAGING_REF={FAKE_STAGING}\n'),
    ('PROD_REF is not a plain word', 'PROD_REF=abc def\n'),
    ('PROD_REF holds shell syntax', 'PROD_REF=$(echo x)\n'),
    ('guard.conf is not text', b'\xff\xfe\x00PROD_REF=\x80\x81\n'),
]:
    refused(f'refuses when {label}', run(GOOD, make_root(guard=guard)), 'PROD_REF')
root = make_root()
os.remove(os.path.join(root, GUARD))
os.mkdir(os.path.join(root, GUARD))
refused('refuses when guard.conf is a directory', run(GOOD, root), 'PROD_REF')

# --------------------------------------------------------------------------
section('5. nothing overrides the refusal')

OVERRIDES = {name: value
             for stem in ('ALLOW_PRODUCTION', 'ALLOW_PROD', 'PRODUCTION', 'FORCE', 'OVERRIDE',
                          'UNSAFE', 'SKIP_CHECK', 'NO_GUARD', 'I_KNOW_WHAT_I_AM_DOING')
             for name, value in ((stem, '1'), ('DRILL_E2E_' + stem, 'true'), ('E2E_' + stem, 'yes'))}
OVERRIDES.update({'CI': 'true', 'E2E_PORT': '3000', 'E2E_PASSWORD': FAKE_SECRET,
                  'SUPABASE_PROJECT_REF': FAKE_STAGING, 'STAGING_REF': FAKE_PROD,
                  'PROD_REF': FAKE_STAGING,
                  'VITE_SUPABASE_URL': url_for(FAKE_STAGING)})
FLAGS = ('--production', '--force', '--allow-production', '--yes', '-f', '--no-guard')
refused('production is refused whatever else is in the environment or on the command line',
        run({**OVERRIDES, **GOOD, N_URL: url_for(FAKE_PROD)}, args=FLAGS), 'production')
refused('a missing value is refused whatever else is in the environment or on the command line',
        run({**OVERRIDES, N_URL: GOOD[N_URL], N_KEY: GOOD[N_KEY]}, args=FLAGS), N_PW)
refused('an unreadable PROD_REF is refused whatever else is in the environment',
        run({**OVERRIDES, **GOOD}, make_root(guard=None), args=FLAGS), 'PROD_REF')
rc, out, err = run({**GOOD, N_URL: url_for(FAKE_PROD)},
                   code='import _target\nprint("reached the suite body")')
check('code after `import _target` never runs when it refuses',
      rc == 2 and 'reached' not in out, f'exit {rc}, stdout {out!r}')

# --------------------------------------------------------------------------
section('6. device suites need a declared matching build')

DEVICE = 'import _target; _target.require_device_build(); print("device ok")'
refused('refuses a device run with no declared build', run(GOOD, code=DEVICE), N_APK)
refused('refuses a device run whose declared build is for another project',
        run({**GOOD, N_APK: 'someotherproject'}, code=DEVICE), N_APK)
refused('refuses a device run whose declared build is production',
        run({**GOOD, N_APK: FAKE_PROD}, code=DEVICE), N_APK)
refused('a production target is refused before the device gate is reached',
        run({**GOOD, N_URL: url_for(FAKE_PROD), N_APK: FAKE_PROD}, code=DEVICE), 'production')
rc, out, err = run({**GOOD, N_APK: FAKE_STAGING}, code=DEVICE)
check('accepts a device run whose declared build matches the target',
      rc == 0 and 'device ok' in out, f'exit {rc}, stderr {err[-160:]!r}')
refused('apk.py itself refuses on import with no declared build',
        run(GOOD, code='import apk; print("imported")'), N_APK)

SOURCE = ('import _target, sys; a = sys.argv[1:]\n'
          'print(_target.production_source_problem(a[0], "the bundle", a[1] == "need"))')
rc, out, _ = run(GOOD, code=SOURCE, args=('createClient("' + url_for(FAKE_PROD) + '")', 'any'))
check('served source naming production is reported', rc == 0 and 'production' in out, out.strip())
rc, out, _ = run(GOOD, code=SOURCE, args=('createClient("' + url_for(FAKE_PROD).upper() + '")', 'any'))
check('served source naming production in another case is reported',
      rc == 0 and 'production' in out, out.strip())
rc, out, _ = run(GOOD, code=SOURCE, args=('const url = undefined', 'need'))
check('served source without the target URL is reported', rc == 0 and 'target' in out, out.strip())
rc, out, _ = run(GOOD, code=SOURCE, args=('createClient("' + url_for(FAKE_STAGING) + '")', 'need'))
check('served source carrying only the target is accepted', rc == 0 and out.strip() == 'None',
      out.strip())

# --------------------------------------------------------------------------
section('7. the app under test')

START = ('import _target\nbase = _target.start_app()\nprint(base)\n'
         'assert _target.start_app() == base\n'
         'for rel in _target._modules_reading_the_target():\n'
         '    print(_target._fetch(base + "/" + rel)[1])\n')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0


for bad in ('abc', '80', '70000', '-1', '3100; rm -rf x'):
    refused(f'refuses an app port of {bad!r}', run({**GOOD, N_PORT: bad}, code=START), N_PORT)

with socket.socket() as busy:
    busy.bind(('127.0.0.1', 0))
    busy.listen(1)
    taken = busy.getsockname()[1]
    refused('refuses a port something else is already serving, rather than reuse it',
            run({**GOOD, N_PORT: str(taken)}, code=START), 'already in use')

have_vite = os.path.exists(os.path.join(REPO, 'node_modules', '.bin', 'vite'))
check('vite is installed, so the app under test can be started', have_vite and bool(shutil.which('npx')),
      '' if have_vite else 'run npm install')
if have_vite and shutil.which('npx') and REAL_PROD:
    env_local = ''
    try:
        with open(os.path.join(REPO, '.env.local'), encoding='utf-8') as f:
            env_local = f.read()
    except OSError:
        pass
    port = free_port()
    rc, out, err = run({**GOOD, N_PORT: str(port)}, code=START, timeout=300)
    check('start_app() starts Vite on the requested loopback port',
          rc == 0 and out.startswith(f'http://127.0.0.1:{port}\n'),
          f'exit {rc}, stderr {err[-200:]!r}' if rc else '')
    check('the served app carries the target project URL', rc == 0 and url_for(FAKE_STAGING) in out)
    check('the served app carries the target key', rc == 0 and FAKE_KEY in out)
    check('the served app does not carry the production ref',
          rc == 0 and REAL_PROD.lower() not in out.lower(),
          '.env.local names production and was overridden' if REAL_PROD.lower() in env_local.lower()
          else '.env.local does not name production here, so this proves less')
    stopped = False
    for _ in range(40):
        if not port_open(port):
            stopped = True
            break
        time.sleep(0.25)
    check('the server is stopped when the suite exits', stopped, f'port {port}')

# --------------------------------------------------------------------------
section('8. no project literal anywhere under e2e/')

label = r'[A-Za-z0-9][A-Za-z0-9-]*'
FORBIDDEN = [
    ('a project URL or host', re.compile(label + re.escape(HOST_TAIL), re.I)),
    ('a publishable or secret key', re.compile('sb_' + '(publishable|secret)' + r'_[A-Za-z0-9_-]{6,}')),
    ('a JWT-style key', re.compile('ey' + r'J[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
]
if REAL_PROD:
    FORBIDDEN.append(('the production project ref', re.compile(re.escape(REAL_PROD), re.I)))
if REAL_STAGING:
    FORBIDDEN.append(('the staging project ref', re.compile(re.escape(REAL_STAGING), re.I)))
# A quoted literal assigned to something called password / pw. A value that is
# itself an ENV_VAR_NAME is the name of a setting, not a secret.
ASSIGNED = re.compile(r'''(?i)(?:password|passwd|(?<![a-z])pw)['"]?\s*[:=]\s*[fbr]?(['"])([^'"\n]{3,})\1''')
# An (email literal, string literal) pair: a sign-in written out in full.
PAIRED = re.compile(r'''\(\s*['"][^'"\n@]+@[^'"\n]+['"]\s*,\s*['"][^'"\n]+['"]''')

files = []
for folder, _dirs, names in os.walk(E2E):
    files += [os.path.join(folder, n) for n in names]
files.sort()
suites = [f for f in files if f.endswith('.py') and os.path.dirname(f) == E2E]
check('found the suites to scan', len(suites) >= 25, f'{len(files)} file(s), {len(suites)} Python')

hits = []
for path in files:
    rel = os.path.relpath(path, REPO)
    with open(path, 'rb') as f:
        text = f.read().decode('utf-8', 'replace')
    for what, pattern in FORBIDDEN:
        for m in pattern.finditer(text):
            hits.append(f'{rel}:{text.count(chr(10), 0, m.start()) + 1} {what}')
    for m in ASSIGNED.finditer(text):
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', m.group(2)):
            hits.append(f'{rel}:{text.count(chr(10), 0, m.start()) + 1} a password literal')
    for m in PAIRED.finditer(text):
        hits.append(f'{rel}:{text.count(chr(10), 0, m.start()) + 1} an email and password pair')
    for line in reappearing(text):
        hits.append(f'{rel}:{line} a value that must never reappear')
check('no file under e2e/ holds a project URL, ref, key or password literal', not hits,
      '; '.join(hits[:8]) + (f' (+{len(hits) - 8} more)' if len(hits) > 8 else ''))

# canaries: the scan must be able to see what it forbids
canary = '\n'.join([
    'URL = "' + url_for('abcdefghijklmnopqrst') + '"',
    'KEY = "sb_' + 'publishable_' + 'A1b2C3d4E5f6"',
    'KEY = "ey' + 'JhbGciOiJIUzI1NiIs.' + 'eyJpc3MiOiJzdXBhYmFzZSJ9"',
    "{'email': e, 'pass" + "word': 'hunter2hunter2'}",
    "ADMIN_P" + "W = 'letmein123'",
    "ADMIN = ('boss" + "@example.org', 'letmein123')",
    (REAL_PROD or 'none').upper(),
])
seen = {what for what, pattern in FORBIDDEN if pattern.search(canary)}
check('the scan recognises every kind of literal it forbids',
      seen == {what for what, _ in FORBIDDEN if what != 'the staging project ref'}
      and len(ASSIGNED.findall(canary)) == 2 and len(PAIRED.findall(canary)) == 1,
      str(sorted(seen)))

# The digest scan is proved on a value made up for this run, so nothing that
# was ever used is written or rebuilt here.
probe = uuid.uuid4().hex[:6] + 'Aa1!'
probe_digest = {hashlib.sha256(probe.encode('utf-8')).hexdigest()}
check('the digest scan finds a value by its digest alone: quoted or as a bare token',
      reappearing('a = 1\nx = "' + probe + '"\n', probe_digest) == [2]
      and reappearing("f(e, '" + probe + "')\n", probe_digest) == [1]
      and reappearing('one\ntwo\nit was ' + probe + ' once\n', probe_digest) == [3]
      and reappearing(probe, probe_digest) == [1])
check('the digest scan stays quiet about any other value',
      reappearing('x = "' + probe + '"\n') == []
      and reappearing('x = "' + probe + 'x"\nit was x' + probe + ' once\n', probe_digest) == [])
check('the digests kept here are SHA-256 digests, not values',
      bool(NEVER_AGAIN) and all(re.fullmatch(r'[0-9a-f]{64}', d) for d in NEVER_AGAIN))

# --------------------------------------------------------------------------
section('9. every suite takes its connection from _target')

NO_DATABASE = {'_target.py', 'target_selftest.py', 'unsupported_browser_e2e.py'}
DEVICE_FILES = {'apk.py', 'apk_sync_e2e.py', 'apk_photo_e2e.py'}
not_first, own_server, no_start, direct_env = [], [], [], []
for path in suites:
    name = os.path.basename(path)
    if name in NO_DATABASE:
        continue
    with open(path, encoding='utf-8') as f:
        text = f.read()
    body = ast.parse(text).body
    imports = [n for n in body if isinstance(n, (ast.Import, ast.ImportFrom))]
    first_code = next((n for n in body if not (isinstance(n, ast.Expr)
                                               and isinstance(getattr(n, 'value', None), ast.Constant))), None)
    if not (isinstance(first_code, ast.Import) and [a.name for a in first_code.names] == ['_target']
            and imports and imports[0] is first_code):
        not_first.append(name)
    if re.search(r'localhost:3000|E2E_PORT|npm.{0,12}run.{0,12}dev|\.env\.local|'
                 r'environ[^\n]*(SUPABASE|PUBLISHABLE|PASSWORD|_KEY|_URL)', text):
        direct_env.append(name)
    if name in DEVICE_FILES:
        continue
    if 'playwright' in text:
        if '_target.start_app()' not in text:
            no_start.append(name)
        if re.search(r'https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)', text):
            own_server.append(name)
check('`import _target` is the first statement of every suite', not not_first, ', '.join(not_first))
check('no suite reads the connection from anywhere else', not direct_env, ', '.join(direct_env))
check('every browser suite gets the app address from _target.start_app()', not no_start,
      ', '.join(no_start))
check('no browser suite names a local server of its own', not own_server, ', '.join(own_server))

with open(os.path.join(E2E, 'apk.py'), encoding='utf-8') as f:
    apk_text = f.read()
gate, pw_import = apk_text.find('_target.require_device_build()'), apk_text.find('from playwright')
check('apk.py checks the declared build before it loads anything else', 0 < gate < pw_import)
late = []
for name in ('apk_sync_e2e.py', 'apk_photo_e2e.py'):
    with open(os.path.join(E2E, name), encoding='utf-8') as f:
        body = ast.parse(f.read()).body
    position = next((i for i, n in enumerate(body)
                     if isinstance(n, ast.ImportFrom) and n.module == 'apk'), None)
    if position is None or any(not isinstance(n, (ast.Import, ast.ImportFrom, ast.Expr))
                               for n in body[:position]):
        late.append(name)
check('device suites import apk before they do anything', not late, ', '.join(late))

with open(os.path.join(E2E, 'unsupported_browser_e2e.py'), encoding='utf-8') as f:
    text = f.read()
check('the unsupported-browser suite still serves the built output, not a database',
      "'vite', 'preview'" in text and '_target' not in text)

# --------------------------------------------------------------------------
for root in _roots:
    shutil.rmtree(root, ignore_errors=True)

passed = sum(1 for _, ok in results if ok)
print(f'\n{passed}/{len(results)} passed')
sys.exit(0 if passed == len(results) else 1)
