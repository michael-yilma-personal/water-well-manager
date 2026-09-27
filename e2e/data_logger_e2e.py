"""The Data Logger role, end to end against the live Supabase project.

A Data Logger is a crew role with the same access as a Driller, so this checks
the whole path an administrator takes to create one and what the account can
then do:
  - the admin-users function creates a Data Logger (and rejects unknown roles)
  - the account holds the role, and cannot promote itself
  - it can write its own borehole and pipe record
  - another crew cannot read them; an administrator can
  - an administrator can change a role, but not their own

The account is created on first run and reused after; it is an example.com test
account, removed with the others by scripts/delete-test-data.sh.
"""
import json
import sys
import urllib.request
import uuid

URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


def call(method, path, token=None, body=None, prefer=None):
    req = urllib.request.Request(URL + path, method=method)
    req.add_header('apikey', KEY)
    req.add_header('Authorization', f'Bearer {token or KEY}')
    req.add_header('Content-Type', 'application/json')
    if prefer:
        req.add_header('Prefer', prefer)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def sign_in(email):
    status, body = call('POST', '/auth/v1/token?grant_type=password',
                        body={'email': email, 'password': 'TestPass123!'})
    assert status == 200, (status, body)
    return body['access_token'], body['user']['id']


EMAIL = 'datalogger1@example.com'

admin_token, admin_id = sign_in('admin1@example.com')
d1_token, d1_id = sign_in('driller1@example.com')

# --- the administrator creates the account through the real function --------
status, body = call('GET', '/functions/v1/admin-users', admin_token)
check('admin can list the crew', status == 200, f'HTTP {status}')
existing = next((u for u in (body or {}).get('users', []) if u['email'] == EMAIL), None)

if existing is None:
    status, body = call('POST', '/functions/v1/admin-users', admin_token, {
        'email': EMAIL, 'password': 'TestPass123!', 'name': 'Test Data Logger',
        'role': 'Data Logger', 'badgeNumber': 'LOG-E2E',
    })
    check('admin can create a Data Logger', status == 201, f'HTTP {status} {str(body)[:80]}')
else:
    check('Data Logger account exists', existing['role'] == 'Data Logger', existing['role'])

status, body = call('POST', '/functions/v1/admin-users', admin_token, {
    'email': f'bogus-{uuid.uuid4().hex[:6]}@example.com', 'password': 'TestPass123!',
    'role': 'Data Loger',
})
check('an unknown role is rejected', status == 400, f'HTTP {status} {str(body)[:60]}')

dl_token, dl_id = sign_in(EMAIL)

_, rows = call('GET', f'/rest/v1/profiles?id=eq.{dl_id}&select=role', dl_token)
check('the account holds the Data Logger role',
      bool(rows) and rows[0]['role'] == 'Data Logger', str(rows))

call('PATCH', f'/rest/v1/profiles?id=eq.{dl_id}', dl_token,
     {'role': 'Administrator'}, prefer='return=representation')
_, rows = call('GET', f'/rest/v1/profiles?id=eq.{dl_id}&select=role', dl_token)
check('Data Logger CANNOT promote themselves',
      bool(rows) and rows[0]['role'] == 'Data Logger', str(rows))

# --- field writes, like a Driller ------------------------------------------
BH, PIPE = str(uuid.uuid4()), str(uuid.uuid4())
status, _ = call('POST', '/rest/v1/boreholes', dl_token, {
    'id': BH, 'name': 'BH-E2E-DL (Data Logger)', 'project': 'E2E Project',
    'client': 'Test Client', 'rig_name': 'Rig #4', 'target_depth': 120,
    'current_depth': 4.55, 'created_by': dl_id,
    'recorded_at': '2026-09-27T08:00:00Z',
}, prefer='return=representation')
check('Data Logger can create a borehole', status in (200, 201), f'HTTP {status}')

status, _ = call('POST', '/rest/v1/pipe_records', dl_token, {
    'id': PIPE, 'borehole_id': BH, 'pipe_number': 1, 'start_depth': 0,
    'end_depth': 4.55, 'pipe_length': 4.55, 'penetration_rate': 18.2,
    'formation': 'Topsoil & Alluvium', 'operator': 'Test Data Logger',
    'created_by': dl_id, 'recorded_at': '2026-09-27T08:19:00Z',
}, prefer='return=representation')
check('Data Logger can log a pipe record', status in (200, 201), f'HTTP {status}')

# --- visibility ---------------------------------------------------------------
_, rows = call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=id', d1_token)
check('another crew CANNOT read the Data Logger\'s record', rows == [], f'got {rows}')

_, rows = call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=id,operator', admin_token)
check('admin CAN read the Data Logger\'s record', bool(rows) and rows[0]['id'] == PIPE, str(rows))

# Soft-delete what this run wrote, so repeated runs do not pile up boreholes
# on the dashboard.
call('PATCH', f'/rest/v1/pipe_records?id=eq.{PIPE}', dl_token, {'deleted_at': '2026-09-27T09:00:00Z'})
call('PATCH', f'/rest/v1/boreholes?id=eq.{BH}', dl_token, {'deleted_at': '2026-09-27T09:00:00Z'})

# --- changing a role from the dashboard ---------------------------------------
def role_of(uid, token):
    _, rows = call('GET', f'/rest/v1/profiles?id=eq.{uid}&select=role', token)
    return rows[0]['role'] if rows else None

status, body = call('PATCH', '/functions/v1/admin-users', admin_token,
                    {'id': dl_id, 'action': 'setRole', 'role': 'Driller'})
check('admin can change a role', status == 200 and role_of(dl_id, dl_token) == 'Driller',
      f'HTTP {status} {str(body)[:60]}')

status, _ = call('PATCH', '/functions/v1/admin-users', admin_token,
                 {'id': dl_id, 'action': 'setRole', 'role': 'Data Logger'})
check('and change it back', status == 200 and role_of(dl_id, dl_token) == 'Data Logger', f'HTTP {status}')

status, _ = call('PATCH', '/functions/v1/admin-users', admin_token,
                 {'id': dl_id, 'action': 'setRole', 'role': 'Owner'})
check('an unknown role is refused', status == 400 and role_of(dl_id, dl_token) == 'Data Logger', f'HTTP {status}')

status, _ = call('PATCH', '/functions/v1/admin-users', admin_token,
                 {'id': admin_id, 'action': 'setRole', 'role': 'Driller'})
check('admin CANNOT change their own role',
      status == 400 and role_of(admin_id, admin_token) == 'Administrator', f'HTTP {status}')

status, _ = call('PATCH', '/functions/v1/admin-users', d1_token,
                 {'id': d1_id, 'action': 'setRole', 'role': 'Administrator'})
check('a driller CANNOT use the function to promote themselves',
      status == 403 and role_of(d1_id, d1_token) == 'Driller', f'HTTP {status}')

passed = sum(1 for _, ok in results if ok)
print(f'\n{passed}/{len(results)} passed')
sys.exit(0 if passed == len(results) else 1)
