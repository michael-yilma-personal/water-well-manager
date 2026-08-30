"""There is one identity in the field app: the account that signed in.

The app used to offer three account controls in the header - "Create or switch
profile", "Manage staff profiles", and a "Switch User / Role" dropdown - all of
which operated on a local list of invented people with ids like `usr-1788`.
None of them could sign in, own a record, or reach the server.

Worse, they no longer even appeared to work. Adopting the signed-in profile
replaces the local list, so a profile created in the field app was silently
wiped about a second later: the driller typed a name, saved, and watched it
revert with no explanation.

Accounts are created by an administrator in the dashboard, which is the only
route that produces something able to log in. The field app states who you are
and where accounts come from, and invents nobody.
"""
import os
import sys

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '3000'))
URL = f'http://localhost:{PORT}'
EMAIL = os.environ.get('E2E_EMAIL', 'driller1@example.com')
PASSWORD = os.environ.get('E2E_PASSWORD', 'TestPass123!')

USERS = "() => JSON.parse(localStorage.getItem('wwdm_users')||'[]')"
BTN_TITLES = """() => [...document.querySelectorAll('button')]
  .map(b => b.title || b.getAttribute('aria-label') || '').filter(Boolean)"""

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))

    page.goto(URL, wait_until='networkidle')
    page.wait_for_timeout(2000)
    if 'link this device' in page.inner_text('body').lower():
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"]', PASSWORD)
        page.get_by_role('button', name='Link this device').click()
        page.wait_for_timeout(7000)

    page.evaluate("""() => {
      const bh={id:crypto.randomUUID(),name:'BH-IDENT',project:'P',client:'C',rigName:'Rig #1',
        targetDepth:100,currentDepth:0,defaultPipeLength:4.55,bitDiameter:8.5,bitType:'DTH',
        gpsCoordinates:{lat:0,lng:0},status:'active',createdAt:new Date().toISOString(),
        updatedAt:new Date().toISOString(),engineHoursStart:0,compressorHoursStart:0,
        currentEngineHours:0,currentCompressorHours:0};
      localStorage.setItem('wwdm_boreholes',JSON.stringify([bh]));
      localStorage.setItem('wwdm_active_borehole_id',bh.id);}""")
    page.reload(wait_until='networkidle')
    page.wait_for_timeout(4000)

    titles = page.evaluate(BTN_TITLES)

    # --- the routes that invented people are gone ----------------------------
    check('no "create profile" control remains',
          not any('create' in t.lower() and 'profile' in t.lower() for t in titles),
          str([t for t in titles if 'profile' in t.lower()]))
    check('no local "manage staff profiles" control remains',
          not any('staff' in t.lower() for t in titles),
          str([t for t in titles if 'staff' in t.lower()]))

    # --- what replaces them says who you are and where accounts come from ----
    page.locator('button[aria-expanded]').last.click()
    page.wait_for_timeout(900)
    panel = page.inner_text('body')

    check('the identity panel names the signed-in account', 'James Wanjala' in panel)
    check('it states the role', 'driller' in panel.lower())
    check('it no longer offers to switch user or role',
          'switch user' not in panel.lower(), 'still offers a switcher')
    # A distinctive phrase: 'dashboard' alone also matches the page title.
    check('it says where crew accounts come from',
          'managed by an administrator' in panel.lower(),
          panel[-200:].replace('\n', ' '))

    if out := os.environ.get('E2E_OUT'):
        page.screenshot(path=f'{out}/identity-panel.png',
                        clip={'x': 640, 'y': 0, 'width': 640, 'height': 400})

    # --- and nothing can invent a local operator any more --------------------
    users = page.evaluate(USERS)
    check('exactly one identity exists on the device', len(users) == 1, str(users))
    check('and it is the real account, not a usr-* invention',
          not str(users[0]['id']).startswith('usr-'), str(users[0]['id']))
    check('no JS errors', not errs, str(errs[:2]))

    ctx.close()
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
