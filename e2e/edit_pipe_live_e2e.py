"""Correcting a saved pipe record, end to end against the live Supabase project.

  - another driller cannot change someone's pipe
  - a Supervisor and an Administrator can correct the End Pipe fields, and are
    stamped as the editor
  - nobody but the author can change depth, time or delete it
  - an Administrator still cannot create field data
  - a retried upload that changes nothing is not recorded as an edit
  - the correction reaches the author's phone on its next download
  - the dashboard offers Edit to a Supervisor, saves, and shows who edited

Uses the example.com test accounts driller1, driller2, supervisor1, admin1:
create them with scripts/create-user.sh first and remove them with
scripts/delete-test-data.sh.
"""
import json
import os
import sys
import tempfile
import time
import urllib.request
import uuid

from playwright.sync_api import sync_playwright

OUT = os.environ.get('E2E_OUT', tempfile.gettempdir())
URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'
APP = 'http://localhost:3000'
PW = 'TestPass123!'

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

def call(method, path, token, body=None, prefer=None):
    req = urllib.request.Request(URL + path, method=method)
    req.add_header('apikey', KEY); req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Content-Type', 'application/json')
    if prefer: req.add_header('Prefer', prefer)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read().decode(); return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw

def sign_in(email):
    s, b = call('POST', '/auth/v1/token?grant_type=password', KEY, {'email': email, 'password': PW})
    assert s == 200, (email, s, b); return b['access_token'], b['user']['id']

d1, d1_id = sign_in('driller1@example.com')
d2, _ = sign_in('driller2@example.com')
sup, sup_id = sign_in('supervisor1@example.com')
adm, adm_id = sign_in('admin1@example.com')

BH, PIPE = str(uuid.uuid4()), str(uuid.uuid4())
BH_NAME = f'BH-EDIT-{int(time.time()) % 100000}'
row = lambda: call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=*', adm)[1][0]

call('POST', '/rest/v1/boreholes', d1, {'id': BH, 'name': BH_NAME, 'project': 'Edit test', 'client': 'C',
     'rig_name': 'Rig #1', 'target_depth': 100, 'current_depth': 4.55, 'default_pipe_length': 4.55,
     'bit_diameter': 8.5, 'bit_type': 'DTH Hammer - Button Bit', 'status': 'active', 'created_by': d1_id,
     'recorded_at': '2026-09-28T08:00:00Z'})
original = {'id': PIPE, 'borehole_id': BH, 'pipe_number': 1, 'start_depth': 0, 'end_depth': 4.55,
            'pipe_length': 4.55, 'start_time': '2026-09-28T08:00:00Z', 'end_time': '2026-09-28T08:30:00Z',
            'duration_seconds': 1800, 'penetration_rate': 9.1, 'formation': 'Topsoil & Alluvium',
            'water_strike': False, 'air_pressure': 250, 'compressor_pressure': 220,
            'bit_type': 'DTH Hammer - Button Bit', 'bit_diameter': 8.5, 'operator': 'Test Driller One',
            'remarks': 'typed at the rig', 'created_by': d1_id, 'recorded_at': '2026-09-28T08:30:00Z'}
s, _ = call('POST', '/rest/v1/pipe_records', d1, original)
check('driller logs a pipe', s in (200, 201), f'HTTP {s}')
received = row()

# --- who may correct
s, b = call('PATCH', f'/rest/v1/pipe_records?id=eq.{PIPE}', d2, {'formation': 'HIJACKED'}, 'return=representation')
check('another driller CANNOT correct it', b == [] and row()['formation'] == 'Topsoil & Alluvium', f'HTTP {s} {b}')

s, b = call('GET', f'/rest/v1/pipe_records?id=eq.{PIPE}&select=id', sup)
check('supervisor CAN read the crew\'s pipe', bool(b), str(b))
s, b = call('GET', f'/rest/v1/boreholes?id=eq.{BH}&select=id', sup)
check('supervisor CAN read the crew\'s borehole', bool(b), str(b))

s, b = call('PATCH', f'/rest/v1/pipe_records?id=eq.{PIPE}', sup,
            {'formation': 'Weathered Basalt', 'remarks': 'supervisor corrected'}, 'return=representation')
r = row()
check('supervisor CAN correct formation and remarks', s == 200 and r['formation'] == 'Weathered Basalt'
      and r['remarks'] == 'supervisor corrected', f'HTTP {s} {str(b)[:120]}')
check('the correction is stamped with the supervisor', r['edited_by'] == sup_id and r['edited_at'])
check('modified_at moved, so phones will download it', r['modified_at'] > received['modified_at'],
      f"{received['modified_at']} -> {r['modified_at']}")

s, b = call('PATCH', f'/rest/v1/pipe_records?id=eq.{PIPE}', adm, {'bit_type': 'Tricone Roller Bit'}, 'return=representation')
r = row()
check('administrator CAN correct the bit', s == 200 and r['bit_type'] == 'Tricone Roller Bit', f'HTTP {s} {str(b)[:120]}')
check('...and is stamped as the editor', r['edited_by'] == adm_id)

# --- what may not be corrected
for who, tok in (('supervisor', sup), ('administrator', adm)):
    s, b = call('PATCH', f'/rest/v1/pipe_records?id=eq.{PIPE}', tok, {'end_depth': 999}, 'return=representation')
    check(f'{who} CANNOT change depth', s >= 400 and float(row()['end_depth']) == 4.55, f'HTTP {s} {str(b)[:90]}')
    s, b = call('PATCH', f'/rest/v1/pipe_records?id=eq.{PIPE}', tok, {'deleted_at': '2026-09-28T12:00:00Z'}, 'return=representation')
    check(f'{who} CANNOT delete it', s >= 400 and row()['deleted_at'] is None, f'HTTP {s}')
s, b = call('POST', '/rest/v1/pipe_records', adm, {**original, 'id': str(uuid.uuid4()), 'created_by': adm_id})
check('administrator still CANNOT create field data', s >= 400, f'HTTP {s}')

# --- a phone retrying an upload that changes nothing is not an edit
before = row()
same = {k: before[k] for k in original}
s, _ = call('POST', '/rest/v1/pipe_records', d1, same, 'resolution=merge-duplicates')
after = row()
check('a no-change re-upload keeps the last editor', s in (200, 201) and after['edited_by'] == adm_id
      and after['edited_at'] == before['edited_at'], f"HTTP {s} {after['edited_by']}")

with sync_playwright() as p:
    browser = p.chromium.launch()
    errs = []
    # --- the author's phone downloads the correction
    field = browser.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True).new_page()
    field.on('pageerror', lambda e: errs.append(str(e)))
    field.goto(APP, wait_until='networkidle'); field.wait_for_timeout(2000)
    field.fill('input[type="email"]', 'driller1@example.com'); field.fill('input[type="password"]', PW)
    field.get_by_role('button', name='Link this device').click(); field.wait_for_timeout(9000)
    local = field.evaluate("(id) => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').find(r => r.id === id) || null", PIPE)
    check('the phone downloads the corrected pipe', bool(local) and local['formation'] == 'Weathered Basalt'
          and local['bitType'] == 'Tricone Roller Bit' and local['remarks'] == 'supervisor corrected', str(local)[:160])

    # --- the supervisor corrects it from the dashboard
    office = browser.new_context(viewport={'width': 1400, 'height': 900}).new_page()
    office.on('pageerror', lambda e: errs.append(str(e)))
    office.goto(f'{APP}/admin.html', wait_until='networkidle'); office.wait_for_timeout(1500)
    office.fill('input[type="email"]', 'supervisor1@example.com'); office.fill('input[type="password"]', PW)
    office.get_by_role('button', name='Sign in').click(); office.wait_for_timeout(4000)
    check('supervisor sees the crew\'s borehole on the dashboard', office.locator('tr', has_text=BH_NAME).count() == 1)
    check('supervisor is not offered Crew management', office.get_by_role('button', name='Crew').count() == 0)
    office.locator('tr', has_text=BH_NAME).click(); office.wait_for_timeout(2500)
    office.get_by_role('button', name='Edit pipe 1').click(); office.wait_for_timeout(700)
    dlg = office.get_by_role('dialog')
    dlg.locator('select').nth(0).select_option('Fractured Basalt (Water Bearing)')
    dlg.locator('textarea').fill('Checked against the geologist log')
    office.screenshot(path=f'{OUT}/edit-pipe-dashboard.png')
    dlg.get_by_role('button', name='Save Changes').click(); office.wait_for_timeout(2500)
    r = row()
    check('dashboard edit is saved', r['formation'] == 'Fractured Basalt (Water Bearing)'
          and r['remarks'] == 'Checked against the geologist log' and r['edited_by'] == sup_id)
    body = office.inner_text('body')
    check('dashboard shows who edited', 'Edited by Test Supervisor' in body, body[body.find('Pipe log'):][:300].replace('\n', ' | '))
    office.screenshot(path=f'{OUT}/edit-pipe-dashboard-saved.png', full_page=True)
    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
