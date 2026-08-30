"""Handing the phone to another driller.

The field app had no way out of an account: once linked, a handset stayed linked
until someone cleared browser storage by hand. Switching drillers is a real
field action, so it needs a real control - and one that refuses to run while
records are still on the phone, because the transport stamps created_by when a
record drains and would credit this driller's work to whoever signs in next.
"""
import os
import sys
import uuid

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '3000'))
URL = f'http://localhost:{PORT}'
EMAIL = os.environ.get('E2E_EMAIL', 'driller1@example.com')
PASSWORD = os.environ.get('E2E_PASSWORD', 'TestPass123!')

QUEUE = "() => JSON.parse(localStorage.getItem('wwdm_outbox') || '[]').length"
PIPES = "() => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').length"
WATERMARK = "() => localStorage.getItem('wwdm_pull_watermark')"
SIGNOUT_BTN = """() => {
  const b = [...document.querySelectorAll('button')]
    .find(x => x.innerText.trim().toLowerCase() === 'sign out');
  return b ? { found: true, disabled: b.disabled } : { found: false };
}"""

MARKER = f'BH-SO-{uuid.uuid4().hex[:6].upper()}'
results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


def open_settings(page):
    """Rig Settings lives inside the borehole menu in the header."""
    page.get_by_text(MARKER, exact=False).first.click()
    page.wait_for_timeout(600)
    page.get_by_text('Rig Settings', exact=True).click()
    page.wait_for_timeout(900)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 400, 'height': 860}, is_mobile=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('dialog', lambda d: d.accept())

    page.goto(URL, wait_until='networkidle')
    page.wait_for_timeout(2000)
    if 'link this device' in page.inner_text('body').lower():
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"]', PASSWORD)
        page.get_by_role('button', name='Link this device').click()
        page.wait_for_timeout(7000)

    page.evaluate(
        """(name) => {
          const bh = { id: crypto.randomUUID(), name, project:'SignOut', client:'C',
            rigName:'Rig #1', targetDepth:100, currentDepth:0, defaultPipeLength:4.55,
            bitDiameter:8.5, bitType:'DTH', gpsCoordinates:{lat:0,lng:0}, status:'active',
            createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
            engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0,
            currentCompressorHours:0 };
          const l = JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]');
          l.unshift(bh);
          localStorage.setItem('wwdm_boreholes', JSON.stringify(l));
          localStorage.setItem('wwdm_active_borehole_id', bh.id);
        }""",
        MARKER,
    )
    page.reload(wait_until='networkidle')
    page.wait_for_timeout(3500)
    for _ in range(30):
        if page.evaluate(QUEUE) == 0:
            break
        page.wait_for_timeout(1000)

    # --- the control exists at all -------------------------------------------
    open_settings(page)
    state = page.evaluate(SIGNOUT_BTN)
    check('a sign-out control exists in the field app', state['found'], str(state))
    check('it is enabled with nothing outstanding', state.get('disabled') is False, str(state))
    page.keyboard.press('Escape')
    page.wait_for_timeout(700)

    # --- it refuses while records are still on the phone ----------------------
    ctx.set_offline(True)
    page.get_by_text('START PIPE', exact=True).click()
    page.wait_for_timeout(700)
    page.get_by_text('END PIPE', exact=True).click()
    page.wait_for_timeout(900)
    page.get_by_text('SAVE PIPE RECORD').click()
    page.wait_for_timeout(2500)
    check('the pipe is queued and unsent', page.evaluate(QUEUE) > 0, f'queue={page.evaluate(QUEUE)}')

    open_settings(page)
    blocked = page.evaluate(SIGNOUT_BTN)
    check('sign-out is refused while work is unsent', blocked.get('disabled') is True, str(blocked))
    check('and it says why', 'still on this phone' in page.inner_text('body'))
    page.keyboard.press('Escape')
    page.wait_for_timeout(700)

    # --- once uploaded, it goes through ---------------------------------------
    ctx.set_offline(False)
    drained = False
    for _ in range(40):
        page.wait_for_timeout(1200)
        if page.evaluate(QUEUE) == 0:
            drained = True
            break
    check('the queue drains once back online', drained, f'queue={page.evaluate(QUEUE)}')

    open_settings(page)
    ready = page.evaluate(SIGNOUT_BTN)
    check('sign-out becomes available again', ready.get('disabled') is False, str(ready))

    page.get_by_role('button', name='Sign Out').click()
    page.wait_for_timeout(3000)

    body = page.inner_text('body').lower()
    check('the device returns to the sign-in screen', 'link this device' in body, body[:70])
    check('the previous driller records are cleared', page.evaluate(PIPES) == 0,
          f'{page.evaluate(PIPES)} record(s) left behind')
    check('the pull watermark is reset', page.evaluate(WATERMARK) is None,
          str(page.evaluate(WATERMARK)))
    check('no JS errors', not errs, str(errs[:2]))

    out = os.environ.get('E2E_OUT')
    if out:
        page.screenshot(path=f'{out}/signout.png')

    ctx.close()
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
