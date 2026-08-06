"""Crew management through the dashboard UI, against the live project.

Covers what an administrator actually does: add a driller, have that driller
sign in, then remove them - and confirms that removing someone who has logged
work disables the account rather than erasing who did the drilling.
"""
import json
import sys
import urllib.request
import uuid

from playwright.sync_api import sync_playwright

OUT = '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'
URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'
ADMIN = ('info@periplusbusiness.com', 'drill4ethio')

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

marker = uuid.uuid4().hex[:8]
new_email = f'crew-{marker}@example.com'
new_pw = 'crewpass1234'

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('dialog', lambda d: d.accept())

    page.goto('http://localhost:3000/admin.html', wait_until='networkidle')
    page.wait_for_timeout(1500)
    page.fill('input[type="email"]', ADMIN[0])
    page.fill('input[type="password"]', ADMIN[1])
    page.get_by_role('button', name='Sign in').click()
    page.wait_for_timeout(5000)

    page.get_by_role('button', name='Crew').click()
    page.wait_for_timeout(4000)
    body = page.inner_text('body')
    check('crew screen opens', 'Accounts that can sign in' in body, body[:70].replace('\n', ' | '))
    check('existing accounts are listed', 'info@periplusbusiness.com' in body)
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
    gone = sign_in(new_email, new_pw)
    check('deleted account can no longer sign in', 'error' in gone, str(gone)[:70])

    # --- someone with records is disabled, not erased -----------------------
    d1 = page.locator('tr', has_text='driller1@example.com')
    check('an account with records offers Disable, not Delete',
          d1.get_by_role('button', name='Disable').count() > 0,
          'their pipe records name them, so the account must survive')

    d1.get_by_role('button', name='Disable').first.click()
    page.wait_for_timeout(6000)
    body = page.inner_text('body')
    check('the account is shown as disabled, still listed',
          'driller1@example.com' in body and 'Disabled' in body)
    blocked = sign_in('driller1@example.com', 'TestPass123!')
    check('a disabled driller cannot sign in', 'error' in blocked, str(blocked)[:70])

    # their drilling records must be untouched
    r = urllib.request.Request(f'{URL}/rest/v1/pipe_records?select=id')
    r.add_header('apikey', KEY)
    r.add_header('Authorization', f"Bearer {sign_in(*ADMIN)['access_token']}")
    remaining = len(json.loads(urllib.request.urlopen(r).read().decode()))
    check('their drilling records survive', remaining > 0, f'{remaining} pipe record(s) still present')
    page.screenshot(path=f'{OUT}/crew-disabled.png')

    # --- and it is reversible ------------------------------------------------
    d1 = page.locator('tr', has_text='driller1@example.com')
    d1.get_by_role('button', name='Restore').first.click()
    page.wait_for_timeout(6000)
    restored = sign_in('driller1@example.com', 'TestPass123!')
    check('restoring lets them sign in again', bool(restored.get('access_token')), str(restored)[:70])

    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
