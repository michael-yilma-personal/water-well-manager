"""An administrator must be told they cannot log field data, not discover it later.

Administrators may read the drilling record but not author it - the insert
policy is `created_by = auth.uid() and not is_admin()`, so the log that backs
client billing cannot be written by someone who was never at the rig.

Nothing said so in the app. An administrator could log a whole shift, watch the
badge, and only find out at upload time, by which point the records were stuck
in a queue that account can never drain. This checks the app says so up front
and refuses to start a pipe, while a driller is unaffected.
"""
import os
import sys

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '3000'))
URL = f'http://localhost:{PORT}'
PASSWORD = os.environ.get('E2E_PASSWORD', 'TestPass123!')
ADMIN = 'admin1@example.com'
DRILLER = 'driller1@example.com'

BANNER_PHRASE = 'cannot log field data'
START_BTN = """() => {
  const b = [...document.querySelectorAll('button')]
    .find(x => /START PIPE/i.test(x.innerText));
  return b ? { found: true, disabled: b.disabled } : { found: false };
}"""

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


def prepare(browser, email, label):
    ctx = browser.new_context(viewport={'width': 400, 'height': 860}, is_mobile=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(URL, wait_until='networkidle')
    page.wait_for_timeout(2000)
    if 'link this device' in page.inner_text('body').lower():
        page.fill('input[type="email"]', email)
        page.fill('input[type="password"]', PASSWORD)
        page.get_by_role('button', name='Link this device').click()
        page.wait_for_timeout(7000)

    # A borehole to sit on, local only - the point is what the app allows, not
    # what reaches the server.
    page.evaluate(
        """(name) => {
          const bh = { id: crypto.randomUUID(), name, project:'RO', client:'C',
            rigName:'Rig #1', targetDepth:100, currentDepth:0, defaultPipeLength:4.55,
            bitDiameter:8.5, bitType:'DTH', gpsCoordinates:{lat:0,lng:0}, status:'active',
            createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
            engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0,
            currentCompressorHours:0 };
          localStorage.setItem('wwdm_boreholes', JSON.stringify([bh]));
          localStorage.setItem('wwdm_active_borehole_id', bh.id);
        }""",
        f'BH-RO-{label}',
    )
    page.reload(wait_until='networkidle')
    page.wait_for_timeout(4000)
    return ctx, page, errs


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- an administrator is told, and blocked ------------------------------
    ctx_a, page_a, errs_a = prepare(browser, ADMIN, 'ADMIN')
    body_a = page_a.inner_text('body')
    start_a = page_a.evaluate(START_BTN)

    check('the administrator is told they cannot log data', BANNER_PHRASE in body_a,
          body_a[:150].replace('\n', ' '))
    check('START PIPE is disabled for an administrator',
          start_a.get('disabled') is True, str(start_a))
    check('[admin] no JS errors', not errs_a, str(errs_a[:2]))

    if out := os.environ.get('E2E_OUT'):
        page_a.screenshot(path=f'{out}/admin-readonly.png',
                          clip={'x': 0, 'y': 0, 'width': 400, 'height': 420})
    ctx_a.close()

    # ---- a driller is unaffected --------------------------------------------
    ctx_b, page_b, errs_b = prepare(browser, DRILLER, 'DRILLER')
    body_b = page_b.inner_text('body')
    start_b = page_b.evaluate(START_BTN)

    check('a driller sees no such warning', BANNER_PHRASE not in body_b)
    check('and can still start a pipe', start_b.get('disabled') is False, str(start_b))
    check('[driller] no JS errors', not errs_b, str(errs_b[:2]))
    ctx_b.close()

    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
