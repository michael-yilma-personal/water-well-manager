"""The sync badge must never claim work is safe when it is not.

The pending count used to refresh only after a drain or a manual tap, never
when a record was saved, so the header sat on a green "Cloud Synced" while
records were queued and unsent - the one reassurance a driller must not be
given falsely.
"""
import sys

from playwright.sync_api import sync_playwright

OUT = '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'

BADGE = """() => {
  const b = [...document.querySelectorAll('button')]
    .find(x => /offline|synced|syncing/i.test(x.innerText) || /synchron/i.test(x.title || ''));
  if (!b) return null;
  return { text: b.innerText.trim(), disabled: b.disabled };
}"""
QUEUE = "() => JSON.parse(localStorage.getItem('wwdm_outbox') || '[]').length"

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, label in ((1280, 'desktop'), (400, 'phone')):
        ctx = browser.new_context(viewport={'width': width, 'height': 860}, is_mobile=(width < 600))
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto('http://localhost:3000', wait_until='networkidle')
        page.wait_for_timeout(2000)
        # Link properly: an unlinked device has no account to attribute records
        # to, so it cannot drain and the round trip could never complete.
        if 'link this device' in page.inner_text('body').lower():
            page.fill('input[type="email"]', 'driller2@example.com')
            page.fill('input[type="password"]', 'TestPass123!')
            page.get_by_role('button', name='Link this device').click()
            page.wait_for_timeout(7000)

        # Linking clears the sample job, so give it a real borehole to log on.
        if 'No borehole on this device yet' in page.inner_text('body'):
            page.evaluate("""() => {
              const bh = { id: crypto.randomUUID(), name:'BH-BADGE', project:'Badge', client:'C',
                rigName:'Rig #1', targetDepth:100, currentDepth:0, defaultPipeLength:4.55,
                bitDiameter:8.5, bitType:'DTH', gpsCoordinates:{lat:0,lng:0}, status:'active',
                createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
                engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0,
                currentCompressorHours:0 };
              const l = JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]'); l.unshift(bh);
              localStorage.setItem('wwdm_boreholes', JSON.stringify(l));
              localStorage.setItem('wwdm_active_borehole_id', bh.id);
            }""")
            page.reload(wait_until='networkidle')
            page.wait_for_timeout(3500)
            for _ in range(20):
                page.wait_for_timeout(1200)
                if page.evaluate(QUEUE) == 0:
                    break

        print(f'--- {label} ({width}px) ---')
        idle = page.evaluate(BADGE)
        check(f'[{label}] idle badge is worded, not a bare icon', bool(idle and idle['text']), str(idle))
        check(f'[{label}] idle badge is not clickable', idle['disabled'] is True, str(idle))

        # queue work with no connection
        ctx.set_offline(True)
        page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(700)
        page.get_by_text('END PIPE', exact=True).click(); page.wait_for_timeout(900)
        page.get_by_text('SAVE PIPE RECORD').click(); page.wait_for_timeout(2500)

        queued = page.evaluate(QUEUE)
        pending = page.evaluate(BADGE)
        check(f'[{label}] work is genuinely queued', queued > 0, f'{queued} operation(s)')
        check(f'[{label}] badge stops claiming everything is synced',
              'synced' not in pending['text'].lower(), str(pending))
        check(f'[{label}] badge shows the outstanding count',
              str(queued) in pending['text'], f"queue={queued} badge={pending['text']!r}")
        check(f'[{label}] badge becomes clickable so it can be retried',
              pending['disabled'] is False, str(pending))
        page.screenshot(path=f'{OUT}/badge-{label}.png', clip={'x': 0, 'y': 0, 'width': width, 'height': 110})

        # reconnect and let it drain
        ctx.set_offline(False)
        drained = False
        for _ in range(40):
            page.wait_for_timeout(1500)
            if page.evaluate(QUEUE) == 0:
                drained = True
                break
        settled = page.evaluate(BADGE)
        check(f'[{label}] queue drains once back online', drained, str(page.evaluate(QUEUE)))
        check(f'[{label}] badge returns to synced afterwards',
              'synced' in settled['text'].lower() and settled['disabled'] is True, str(settled))
        check(f'[{label}] no JS errors', not errs, str(errs[:2]))
        ctx.close()
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
