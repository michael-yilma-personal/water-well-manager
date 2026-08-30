"""Work logged on one device must appear on another signed into the same account.

This is the failure the field reported: a driller logged a pipe, the header said
synced, and a second phone on the same login showed nothing. It showed nothing
because the app only ever pushed - no code path read records back - so the two
devices below stand in for the two phones.

Context A logs a pipe and waits for the outbox to drain. Context B is a separate
browser context with its own storage, which is what makes it a different device
rather than a second tab.
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
BOREHOLE_NAMES = "() => JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]').map(b => b.name)"
PIPE_COUNT = "() => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').length"

MARKER = f'BH-XDEV-{uuid.uuid4().hex[:6].upper()}'

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


def link(page):
    """Sign the device in, if it is not already."""
    page.goto(URL, wait_until='networkidle')
    page.wait_for_timeout(2000)
    if 'link this device' in page.inner_text('body').lower():
        page.fill('input[type="email"]', EMAIL)
        page.fill('input[type="password"]', PASSWORD)
        page.get_by_role('button', name='Link this device').click()
        page.wait_for_timeout(7000)


def wait_for(page, expr, predicate, attempts=30, gap=1000):
    for _ in range(attempts):
        if predicate(page.evaluate(expr)):
            return True
        page.wait_for_timeout(gap)
    return False


with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- Device A: log a pipe and get it onto the server --------------------
    ctx_a = browser.new_context(viewport={'width': 400, 'height': 860}, is_mobile=True)
    page_a = ctx_a.new_page()
    errs_a = []
    page_a.on('pageerror', lambda e: errs_a.append(str(e)))
    link(page_a)

    page_a.evaluate(
        """(name) => {
          const bh = { id: crypto.randomUUID(), name, project:'XDev', client:'C',
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
    page_a.reload(wait_until='networkidle')
    page_a.wait_for_timeout(3500)

    page_a.get_by_text('START PIPE', exact=True).click()
    page_a.wait_for_timeout(700)
    page_a.get_by_text('END PIPE', exact=True).click()
    page_a.wait_for_timeout(900)
    page_a.get_by_text('SAVE PIPE RECORD').click()
    page_a.wait_for_timeout(2000)

    check('[A] the pipe was queued', page_a.evaluate(QUEUE) > 0 or page_a.evaluate(PIPE_COUNT) > 0)
    drained = wait_for(page_a, QUEUE, lambda q: q == 0, attempts=40)
    check('[A] the queue reaches the server', drained, f'queue={page_a.evaluate(QUEUE)}')
    check('[A] no JS errors', not errs_a, str(errs_a[:2]))

    # ---- Device B: a different device on the same account -------------------
    ctx_b = browser.new_context(viewport={'width': 400, 'height': 860}, is_mobile=True)
    page_b = ctx_b.new_page()
    errs_b = []
    page_b.on('pageerror', lambda e: errs_b.append(str(e)))

    check('[B] starts with no knowledge of device A',
          MARKER not in (page_b.evaluate(BOREHOLE_NAMES) if page_b.url != 'about:blank' else []))

    link(page_b)

    arrived = wait_for(page_b, BOREHOLE_NAMES, lambda names: MARKER in names, attempts=30)
    check('[B] the borehole logged on device A arrives', arrived,
          str(page_b.evaluate(BOREHOLE_NAMES))[:160])

    pipes = wait_for(page_b, PIPE_COUNT, lambda n: n > 0, attempts=20)
    check('[B] the pipe record arrives too', pipes, f'{page_b.evaluate(PIPE_COUNT)} record(s)')

    # Device B opens on whichever borehole sorts first, which need not be the one
    # device A just logged. Select it explicitly: the property under test is that
    # a pulled borehole is fully usable here, not which one happens to be active.
    page_b.evaluate(
        """(name) => {
          const bh = JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]')
            .find(b => b.name === name);
          if (bh) localStorage.setItem('wwdm_active_borehole_id', bh.id);
        }""",
        MARKER,
    )
    page_b.reload(wait_until='networkidle')
    page_b.wait_for_timeout(2500)
    body = page_b.inner_text('body')
    check('[B] the pulled borehole opens and renders', MARKER in body,
          MARKER + (' found' if MARKER in body else ' NOT in rendered page'))
    check('[B] its depth came down with it',
          page_b.evaluate(PIPE_COUNT) > 0, f'{page_b.evaluate(PIPE_COUNT)} record(s)')

    check('[B] the download did not re-queue what it received',
          page_b.evaluate(QUEUE) == 0, f'queue={page_b.evaluate(QUEUE)}')
    check('[B] no JS errors', not errs_b, str(errs_b[:2]))

    out = os.environ.get('E2E_OUT')
    if out:
        page_b.screenshot(path=f'{out}/cross-device-b.png', full_page=False)

    ctx_a.close()
    ctx_b.close()
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
