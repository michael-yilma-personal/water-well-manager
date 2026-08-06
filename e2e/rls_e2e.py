"""End-to-end RLS verification against the live Supabase project.

Covers the guarantees the app depends on:
  - a driller can write their own records
  - one crew cannot overwrite another crew's record
  - one crew cannot read another crew's records
  - an administrator can read everything
  - an administrator cannot write
  - a driller cannot promote themselves to administrator
"""
import json
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


d1_token, d1_id = sign_in('driller1@example.com')
d2_token, d2_id = sign_in('driller2@example.com')
admin_token, admin_id = sign_in('admin1@example.com')
print(f'signed in: driller1={d1_id[:8]} driller2={d2_id[:8]} admin={admin_id[:8]}\n')

BH = str(uuid.uuid4())
PIPE = str(uuid.uuid4())

# --- driller 1 writes their own borehole and pipe record --------------------
status, body = call('POST', '/rest/v1/boreholes', d1_token, {
    'id': BH, 'name': 'BH-E2E-01 (Kajiado)', 'project': 'E2E Project',
    'client': 'Test Client', 'rig_name': 'Rig #4', 'target_depth': 120,
    'current_depth': 4.55, 'created_by': d1_id,
    'recorded_at': '2026-08-06T08:00:00Z',
}, prefer='return=representation')
check('driller can create their own borehole', status in (200, 201), f'HTTP {status}')

status, body = call('POST', '/rest/v1/pipe_records', d1_token, {
    'id': PIPE, 'borehole_id': BH, 'pipe_number': 1, 'start_depth': 0,
    'end_depth': 4.55, 'pipe_length': 4.55, 'penetration_rate': 18.2,
    'formation': 'Topsoil & Alluvium', 'operator': 'James Wanjala',
    'remarks': 'ORIGINAL BY DRILLER 1', 'created_by': d1_id,
    'recorded_at': '2026-08-06T08:19:00Z',
}, prefer='return=representation')
check('driller can log a pipe record', status in (200, 201), f'HTTP {status}')

# --- driller 2 tries to overwrite driller 1's record ------------------------
status, body = call('POST', '/rest/v1/pipe_records', d2_token, {
    'id': PIPE, 'borehole_id': BH, 'pipe_number': 1, 'start_depth': 0,
    'end_depth': 999, 'formation': 'HIJACKED', 'operator': 'Peter Otieno',
    'remarks': 'OVERWRITTEN BY DRILLER 2', 'created_by': d2_id,
    'recorded_at': '2026-08-06T09:00:00Z',
}, prefer='resolution=merge-duplicates,return=representation')
check('another crew CANNOT overwrite that record', status not in (200, 201),
      f'HTTP {status} {str(body)[:80]}')

# and prove the original survived, read back by its owner
status, body = call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=remarks,end_depth', d1_token)
intact = bool(body) and body[0]['remarks'] == 'ORIGINAL BY DRILLER 1'
check('original record is intact after the attempt', intact, str(body)[:90])

# --- cross-crew reads --------------------------------------------------------
status, body = call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=id', d2_token)
check('another crew CANNOT read that record', body == [], f'got {body}')

# --- admin visibility --------------------------------------------------------
status, body = call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=id,remarks,operator', admin_token)
check('admin CAN read the field crew\'s records', bool(body) and body[0]['id'] == PIPE,
      str(body)[:90])

status, body = call('GET', '/rest/v1/boreholes?select=id,name', admin_token)
check('admin sees boreholes across crews', any(b['id'] == BH for b in (body or [])),
      f'{len(body or [])} borehole(s) visible')

# --- admin must not write ----------------------------------------------------
status, body = call('POST', '/rest/v1/pipe_records', admin_token, {
    'id': str(uuid.uuid4()), 'borehole_id': BH, 'pipe_number': 99,
    'created_by': admin_id, 'recorded_at': '2026-08-06T10:00:00Z',
}, prefer='return=representation')
check('admin CANNOT write field data', status not in (200, 201), f'HTTP {status}')

# --- self-promotion ----------------------------------------------------------
status, body = call('PATCH', f'/rest/v1/profiles?id=eq.{d1_id}', d1_token,
                    {'role': 'Administrator'}, prefer='return=representation')
promoted = False
if status in (200, 204):
    _, check_body = call('GET', f'/rest/v1/profiles?id=eq.{d1_id}&select=role', d1_token)
    promoted = bool(check_body) and check_body[0]['role'] == 'Administrator'
check('driller CANNOT promote themselves to admin', not promoted,
      f'HTTP {status} {str(body)[:70]}')

# --- soft delete keeps the row ----------------------------------------------
status, _ = call('PATCH', f'/rest/v1/pipe_records?id=eq.{PIPE}', d1_token,
                 {'deleted_at': '2026-08-06T11:00:00Z'})
_, rows = call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=id,deleted_at', d1_token)
check('delete is soft - the audit row survives',
      bool(rows) and rows[0]['deleted_at'] is not None, str(rows)[:80])

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
