"""The badge must stay loud over parked work.

Parking removes an item from depth(), which used to flip the header to a green
"Cloud Synced" while the record was still sitting on the phone.
"""
import os
import sys
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '3000'))
URL = f'http://localhost:{PORT}'
OUT = os.environ.get('E2E_OUT', '/tmp')

BADGE = """() => {
  const b = [...document.querySelectorAll('button')]
    .find(x => /offline|synced|syncing|not sent/i.test(x.innerText));
  return b ? { text: b.innerText.trim(), disabled: b.disabled, cls: b.className } : null;
}"""

SEED = """() => {
  localStorage.setItem('wwdm_auth_user_id', '11111111-1111-4111-8111-111111111111');
  const bh = { id:'22222222-2222-4222-8222-222222222222', name:'BH-PARK', project:'P', client:'C',
    rigName:'Rig #1', targetDepth:100, currentDepth:9.1, defaultPipeLength:4.55, bitDiameter:8.5,
    bitType:'DTH', gpsCoordinates:{lat:0,lng:0}, status:'active',
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0, currentCompressorHours:0 };
  localStorage.setItem('wwdm_boreholes', JSON.stringify([bh]));
  localStorage.setItem('wwdm_active_borehole_id', bh.id);
  // One record the server refused for good: retries exhausted, given up on.
  localStorage.setItem('wwdm_outbox', JSON.stringify([{
    id:'op-parked-1', op:'upsert', entity:'pipeRecord',
    entityId:'33333333-3333-4333-8333-333333333333',
    payload:{ id:'33333333-3333-4333-8333-333333333333', boreholeId:bh.id, pipeNumber:2 },
    attempts:8, lastError:'upsert pipe_records: insufficient_privilege',
    enqueuedAt:new Date().toISOString(), nextAttemptAt:0, parked:true
  }]));
}"""

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
        page.goto(URL, wait_until='networkidle')
        page.evaluate(SEED)
        page.reload(wait_until='networkidle')
        page.wait_for_timeout(3000)

        b = page.evaluate(BADGE)
        check(f'[{label}] badge renders', b is not None, str(b))
        if b:
            check(f'[{label}] does NOT claim synced over parked work',
                  'synced' not in b['text'].lower(), repr(b['text']))
            check(f'[{label}] names the unsent record', '1' in b['text'], repr(b['text']))
            check(f'[{label}] reads as failure, not mere offline',
                  'not sent' in b['text'].lower(), repr(b['text']))
            check(f'[{label}] is clickable so it can be retried',
                  b['disabled'] is False, str(b['disabled']))
            check(f'[{label}] is styled as an alert (red)', 'red' in b['cls'], b['cls'][:90])
        page.screenshot(path=f'{OUT}/parked-{label}.png',
                        clip={'x':0,'y':0,'width':width,'height':110})
        check(f'[{label}] no JS errors', not errs, str(errs[:2]))
        ctx.close()
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
