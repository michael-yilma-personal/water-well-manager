"""Self-test for the refusals of e2e/saas/tenant_fixture.py.

Needs no database and no internet: the fixture module is imported in
subprocesses with a made-up target and a temporary root (DRILL_E2E_ROOT, as in
e2e/target_selftest.py), and importing it performs the checks without opening
a connection. It proves that the fixture

  - takes its privileged access from the environment only, never from .env.e2e;
  - refuses (exit 2, one line on stderr) when either value is missing, names
    production in any spelling, or belongs to another project;
  - never echoes the database secret or the key when it refuses.

Run:  python3 e2e/saas/fixture_selftest.py     (exit 0 only if every check passes)
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
GUARD = os.path.join('scripts', 'hooks', 'guard.conf')

FAKE_PROD = 'fakeprodref' + '0' * 9
FAKE_TARGET = 'faketargetref' + '1' * 7
FAKE_OTHER = 'fakeotherref' + '2' * 8
TAIL = '.example.test'
DB_SECRET = 'db-' + uuid.uuid4().hex
KEY_SECRET = 'key-' + uuid.uuid4().hex

N_DB = 'DRILL_E2E_DB_URL'
N_SERVICE = 'DRILL_E2E_SERVICE_ROLE_KEY'

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


def real_prod_ref():
    with open(os.path.join(REPO, GUARD), encoding='utf-8') as f:
        for line in f:
            if line.startswith('PROD_REF='):
                return line[len('PROD_REF='):].split('#')[0].strip()
    return ''


def db_url(ref, host=None, user=None, scheme='postgresql'):
    user = user if user is not None else 'postgres.' + ref
    host = host if host is not None else 'pooler' + TAIL
    return f'{scheme}://{user}:{DB_SECRET}@{host}:5432/postgres?sslmode=require'


def token(claims):
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return '.'.join([part({'alg': 'none'}), part(claims), KEY_SECRET])


root = tempfile.mkdtemp(prefix='tiso-selftest-')
os.makedirs(os.path.join(root, 'scripts', 'hooks'))
with open(os.path.join(root, GUARD), 'w', encoding='utf-8') as f:
    f.write(f'PROD_REF={FAKE_PROD}\nSTAGING_REF=\n')

SHOW = ('import sys; sys.path.insert(0, sys.argv[1]); import tenant_fixture as t;'
        ' print("LOADED", t._PG_ENV["PGHOST"], t._PG_ENV["PGUSER"])')


def run(db=None, service=None, env_file=None):
    path = os.path.join(root, '.env.e2e')
    if env_file is None:
        if os.path.exists(path):
            os.remove(path)
    else:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(env_file)
    env = {'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''),
           'DRILL_E2E_ROOT': root,
           'DRILL_E2E_SUPABASE_URL': 'https://' + FAKE_TARGET + TAIL,
           'DRILL_E2E_PUBLISHABLE_KEY': 'fake-key-' + uuid.uuid4().hex,
           'DRILL_E2E_PASSWORD': uuid.uuid4().hex}
    if db is not None:
        env[N_DB] = db
    if service is not None:
        env[N_SERVICE] = service
    return subprocess.run([sys.executable, '-B', '-c', SHOW, HERE], env=env, cwd=root,
                          capture_output=True, text=True, timeout=60)


def refused(name, result, mentions=None):
    err = result.stderr.strip()
    ok = (result.returncode == 2 and 'LOADED' not in result.stdout and len(err.splitlines()) == 1
          and err.startswith('_target: refusing to run:')
          and DB_SECRET not in err + result.stdout and KEY_SECRET not in err + result.stdout
          and (mentions is None or mentions in err))
    check(name, ok, f'exit {result.returncode}: {err[:160]}')


good_db = db_url(FAKE_TARGET)
good_key = token({'ref': FAKE_TARGET, 'role': 'service_role'})

r = run(good_db, good_key)
check('accepted: a database URL and a service-role key of the tested project',
      r.returncode == 0 and r.stdout.split()[:1] == ['LOADED'], f'exit {r.returncode} {r.stderr[:160]}')
check('...and the secret is not printed', DB_SECRET not in r.stdout + r.stderr)
r = run(db_url(FAKE_TARGET, host='db.' + FAKE_TARGET + TAIL, user='postgres'), 'opaque-' + KEY_SECRET)
check('accepted: the project named by the host instead of the user, and an opaque key',
      r.returncode == 0, f'exit {r.returncode} {r.stderr[:160]}')

refused('refused: no database URL', run(None, good_key), N_DB)
refused('refused: an empty database URL', run('  ', good_key), N_DB)
refused('refused: no service-role key', run(good_db, None), N_SERVICE)
refused('refused: an empty service-role key', run(good_db, ' '), N_SERVICE)
refused('refused: both only in .env.e2e - a file is never a source of privileged access',
        run(None, None, env_file=f'{N_DB}={good_db}\n{N_SERVICE}={good_key}\n'), N_DB)
refused('refused: the key only in .env.e2e',
        run(good_db, None, env_file=f'{N_SERVICE}={good_key}\n'), N_SERVICE)

refused('refused: the database user names production', run(db_url(FAKE_PROD), good_key), 'production')
refused('refused: the database host names production',
        run(db_url(FAKE_TARGET, host='db.' + FAKE_PROD + TAIL), good_key), 'production')
refused('refused: production in upper case',
        run(db_url(FAKE_PROD.upper()), good_key), 'production')
refused('refused: production percent-encoded in the user',
        run(db_url(FAKE_TARGET, user='postgres.' + urllib.parse.quote(FAKE_PROD[:4], safe='')
                   + '%' + format(ord(FAKE_PROD[4]), '02x') + FAKE_PROD[5:]), good_key), 'production')
refused('refused: production in the query string',
        run(good_db + '&options=project%3D' + FAKE_PROD, good_key), 'production')
real = real_prod_ref()
check('the repository names a production ref to refuse', bool(real))
if real:
    refused('refused: the repository\'s own production ref, whatever DRILL_E2E_ROOT says',
            run(db_url(real), good_key), 'production')
    refused('refused: a key that carries the repository\'s production ref',
            run(good_db, token({'ref': real, 'role': 'service_role'})), 'production')
refused('refused: a database of another project', run(db_url(FAKE_OTHER), good_key), 'does not name')
refused('refused: a database URL that names no project at all',
        run(db_url(FAKE_TARGET, host='10.0.0.7', user='postgres'), good_key), 'does not name')
refused('refused: a local database while the target is a hosted project',
        run(db_url(FAKE_TARGET, host='127.0.0.1', user='postgres'), good_key), 'does not name')
refused('refused: the tested ref only as part of a longer label',
        run(db_url(FAKE_TARGET, user='postgres.x' + FAKE_TARGET), good_key), 'does not name')
refused('refused: not a postgresql URL', run(db_url(FAKE_TARGET, scheme='https'), good_key), 'postgresql')
refused('refused: a database URL without a user',
        run('postgresql://pooler' + TAIL + '/postgres', good_key))
refused('refused: a malformed port', run(good_db.replace(':5432', ':54x2'), good_key), 'valid URL')

refused('refused: a key that names production in clear', run(good_db, FAKE_PROD + '-' + KEY_SECRET),
        'production')
refused('refused: a signed key of the production project',
        run(good_db, token({'ref': FAKE_PROD, 'role': 'service_role'})), 'production')
refused('refused: a signed key of the production project, ref in upper case',
        run(good_db, token({'ref': FAKE_PROD.upper(), 'role': 'service_role'})), 'production')
refused('refused: a signed key of another project',
        run(good_db, token({'ref': FAKE_OTHER, 'role': 'service_role'})), 'different project')
refused('refused: a signed key that is not a service-role key',
        run(good_db, token({'ref': FAKE_TARGET, 'role': 'anon'})), 'service-role')

shutil.rmtree(root, ignore_errors=True)
passed = sum(1 for _, ok in results if ok)
print(f'\n{passed}/{len(results)} passed')
sys.exit(0 if passed == len(results) else 1)
