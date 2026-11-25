"""Crew management through the dashboard UI, against the project named by _target.

Covers what an administrator actually does: add a driller, have that driller
sign in, then remove them - and confirms that removing someone who has logged
work disables the account rather than erasing who did the drilling.

Since P2-4 the Crew screen manages memberships of the organization (D2-5): it
never bans or deletes an account. So the account this suite adds outlives its
removal, without any membership. This suite has no privileged access to delete
it; it is named tiso-...@example.com so that the tenant fixture's sweep (every
suite under e2e/saas/) removes it.
"""
import _target
import json
import sys
import urllib.request
import uuid

from playwright.sync_api import sync_playwright

OUT = _target.OUT
URL = _target.URL
KEY = _target.KEY
ADMIN = (_target.ADMIN1, _target.PASSWORD)

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

def sign_in(email, password):
    r = urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password', method='POST')
    r.add_header('apikey', KEY); r.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(r, json.dumps({'email': email, 'password': password}).encode()) as x:
            return json.loads(x.read().decode())
    except urllib.error.HTTPError as e:
        return {'error': e.code, 'body': e.read().decode()[:90]}

def get(path, token):
    """A PostgREST read as the signed-in person: the parsed rows."""
    r = urllib.request.Request(f'{URL}/rest/v1{path}')
    r.add_header('apikey', KEY); r.add_header('Authorization', f'Bearer {token}')
    return json.loads(urllib.request.urlopen(r).read().decode())

marker = uuid.uuid4().hex[:8]
new_email = f'tiso-crew-{marker}@example.com'
new_pw = uuid.uuid4().hex


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('dialog', lambda d: d.accept())

    page.goto(_target.start_app() + '/admin.html', wait_until='networkidle')
    page.wait_for_timeout(1500)
    page.fill('input[type="email"]', ADMIN[0])
    page.fill('input[type="password"]', ADMIN[1])
    page.get_by_role('button', name='Sign in').click()
    page.wait_for_timeout(5000)

    page.get_by_role('button', name='Crew').click()
    try:  # the list takes 1.6 to 3.4 s on staging: wait for the row, not a fixed time
        page.locator('tr', has_text=ADMIN[0]).first.wait_for(state='visible', timeout=20000)
    except Exception:
        pass
    body = page.inner_text('body')
    check('crew screen opens', 'Accounts that can sign in' in body, body[:70].replace('\n', ' | '))
    check('existing accounts are listed', ADMIN[0] in body)
    page.screenshot(path=f'{OUT}/crew-list.png')

    # --- add a driller ------------------------------------------------------
    page.get_by_role('button', name='Add crew member').click()
    page.wait_for_timeout(800)
    page.fill('input[type="email"]', new_email)
    page.fill('input[placeholder="at least 8 characters"]', new_pw)
    page.fill('input[placeholder="Joe Kamau"]', 'E2E Crew')
    page.fill('input[placeholder="DRL-110"]', 'DRL-E2E')
    page.screenshot(path=f'{OUT}/crew-add.png')
    page.get_by_role('button', name='Create account').click()
    page.wait_for_timeout(6000)

    check('new account appears in the list', new_email in page.inner_text('body'),
          page.inner_text('body')[-160:].replace('\n', ' | '))

    signed = sign_in(new_email, new_pw)
    check('the new driller can sign in', bool(signed.get('access_token')), str(signed)[:90])

    # --- a brand-new account has no records, so it is deleted outright ------
    row = page.locator('tr', has_text=new_email)
    check('delete is offered for an account with no records',
          row.get_by_role('button', name='Delete').count() > 0,
          'expected Delete, not Disable')
    row.get_by_role('button', name='Delete').first.click()
    page.wait_for_timeout(6000)
    check('deleted account disappears', new_email not in page.inner_text('body'))
    check('the notice says they were removed from this organization',
          'was removed from this organization' in page.inner_text('body'))
    gone = sign_in(new_email, new_pw)
    token = gone.get('access_token')
    check('a removed person can still sign in, but has no membership and reads no records',
          bool(token) and get('/rpc/my_organizations', token) == []
          and get('/boreholes?select=id', token) == [], str(gone)[:70])

    # --- someone with records is disabled, not erased -----------------------
    d1 = page.locator('tr', has_text=_target.DRILLER1)
    check('an account with records offers Disable, not Delete',
          d1.get_by_role('button', name='Disable').count() > 0,
          'their pipe records name them, so the account must survive')

    d1.get_by_role('button', name='Disable').first.click()
    page.wait_for_timeout(6000)
    body = page.inner_text('body')
    check('the account is shown as disabled, still listed',
          _target.DRILLER1 in body and 'Disabled' in body)
    check('the notice says they were deactivated in this organization because of their records',
          'was deactivated in this organization because they have' in body and 'record(s) here' in body)
    blocked = sign_in(_target.DRILLER1, _target.PASSWORD)
    token = blocked.get('access_token')
    mine = get('/rpc/my_organizations', token) if token else None
    check('a disabled driller can still sign in, but has no active membership and reads no records',
          bool(token) and [m['status'] for m in mine] == ['deactivated']
          and get('/boreholes?select=id', token) == [] and get('/pipe_records?select=id', token) == [],
          str(mine)[:90])

    # their drilling records must be untouched
    r = urllib.request.Request(f'{URL}/rest/v1/pipe_records?select=id')
    r.add_header('apikey', KEY)
    r.add_header('Authorization', f"Bearer {sign_in(*ADMIN)['access_token']}")
    remaining = len(json.loads(urllib.request.urlopen(r).read().decode()))
    check('their drilling records survive', remaining > 0, f'{remaining} pipe record(s) still present')
    page.screenshot(path=f'{OUT}/crew-disabled.png')

    # --- and it is reversible ------------------------------------------------
    d1 = page.locator('tr', has_text=_target.DRILLER1)
    d1.get_by_role('button', name='Restore').first.click()
    page.wait_for_timeout(6000)
    restored = sign_in(_target.DRILLER1, _target.PASSWORD)
    check('restoring lets them sign in again', bool(restored.get('access_token')), str(restored)[:70])
    check('the notice says they are active in this organization again, and the membership is active',
          'is active in this organization again' in page.inner_text('body')
          and [m['status'] for m in get('/rpc/my_organizations', restored['access_token'])] == ['active'])

    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

print(f'NOTE  the account {new_email} is left, without a membership, until a suite under e2e/saas/ sweeps')
print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
