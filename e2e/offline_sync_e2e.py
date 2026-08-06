"""Offline -> online end-to-end through the real app UI against live Supabase."""
import json, urllib.request, sys
from playwright.sync_api import sync_playwright

OUT = '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'
URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

def server_pipes(token):
    req = urllib.request.Request(
        f'{URL}/rest/v1/pipe_records?select=id,pipe_number,remarks,end_depth&order=pipe_number')
    req.add_header('apikey', KEY)
    req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

def sign_in_api(email):
    req = urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password', method='POST')
    req.add_header('apikey', KEY); req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, json.dumps({'email': email, 'password': 'TestPass123!'}).encode()) as r:
        return json.loads(r.read().decode())['access_token']

d1_api = sign_in_api('driller1@example.com')
admin_api = sign_in_api('admin1@example.com')
before = {p['id'] for p in server_pipes(d1_api)}
print(f'server has {len(before)} pipe record(s) for driller1 before the run\n')

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://localhost:3000', wait_until='networkidle')
    page.wait_for_timeout(2000)

    # --- provision the device -----------------------------------------------
    check('sign-in screen shown on an unprovisioned device',
          'link this device' in page.inner_text('body').lower())
    page.fill('input[type="email"]', 'driller1@example.com')
    page.fill('input[type="password"]', 'TestPass123!')
    page.get_by_role('button', name='Link this device').click()
    page.wait_for_timeout(4000)
    # Linking clears the seeded sample job, so a newly linked device correctly
    # lands on the empty state rather than a fake borehole.
    after_link = page.inner_text('body')
    check('linking lands on a usable screen',
          'No borehole on this device yet' in after_link or 'CURRENT DEPTH' in after_link,
          after_link[:70].replace('\n', ' | '))
    page.screenshot(path=f'{OUT}/e2e-signed-in.png')

    # --- create a real borehole so records have a parent that is not demo ----
    # (demo boreholes are deliberately never synced)
    made = page.evaluate("""() => {
      const bh = {
        id: crypto.randomUUID(),
        name: 'BH-OFFLINE-E2E (Kajiado)',
        project: 'Offline E2E', client: 'Test Client', rigName: 'Rig #4',
        targetDepth: 120, currentDepth: 0, defaultPipeLength: 4.55,
        bitDiameter: 8.5, bitType: 'DTH Hammer - Button Bit',
        gpsCoordinates: {lat: -1.85, lng: 36.78},
        status: 'active',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        engineHoursStart: 0, compressorHoursStart: 0,
        currentEngineHours: 0, currentCompressorHours: 0,
      };
      const list = JSON.parse(localStorage.getItem('wwdm_boreholes') || '[]');
      list.unshift(bh);
      localStorage.setItem('wwdm_boreholes', JSON.stringify(list));
      localStorage.setItem('wwdm_active_borehole_id', bh.id);
      return bh.id;
    }""")
    page.reload(wait_until='networkidle'); page.wait_for_timeout(2500)

    # queue the borehole itself via a save so it reaches the server
    page.evaluate("""(id) => {
      const list = JSON.parse(localStorage.getItem('wwdm_boreholes') || '[]');
      const bh = list.find(b => b.id === id);
      window.__bh = bh;
    }""", made)

    # --- GO OFFLINE ----------------------------------------------------------
    ctx.set_offline(True)
    page.wait_for_timeout(500)

    logged = []
    for i in range(3):
        page.get_by_text('START PIPE', exact=True).click()
        page.wait_for_timeout(700)
        page.get_by_text('END PIPE', exact=True).click()
        page.wait_for_timeout(900)
        page.locator('input[placeholder*="Quartzite"], textarea[placeholder*="Quartzite"]').first.fill(
            f'OFFLINE PIPE {i + 1}')
        page.get_by_text('SAVE PIPE RECORD').click()
        page.wait_for_timeout(1200)
        logged.append(i + 1)

    offline_state = page.evaluate("""() => ({
      queue: JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length,
      depth: (document.body.innerText.match(/CURRENT DEPTH\\s*\\n\\s*([\\d.]+)/)||[])[1],
      pipes: JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').filter(p=>!p.isDemo).length,
    })""")
    check('records are captured while offline', offline_state['pipes'] >= 3,
          f"{offline_state['pipes']} local non-demo pipe(s), depth {offline_state['depth']}")
    check('offline work is queued, not lost', offline_state['queue'] >= 3,
          f"{offline_state['queue']} queued op(s)")
    page.screenshot(path=f'{OUT}/e2e-offline-logged.png')

    mid = {p['id'] for p in server_pipes(d1_api)}
    check('nothing reached the server while offline', mid == before,
          f'{len(mid)} on server (was {len(before)})')

    # --- BACK ONLINE ---------------------------------------------------------
    ctx.set_offline(False)
    page.wait_for_timeout(1500)
    page.evaluate("() => window.dispatchEvent(new Event('online'))")
    page.wait_for_timeout(1000)

    # tap the sync button in the header
    page.locator('button:has-text("Offline"), button:has-text("Synced"), button:has-text("Sync")').first.click()
    page.wait_for_timeout(6000)

    after_state = page.evaluate("""() => ({
      queue: JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length,
      body: (document.body.innerText.match(/Could not upload[^\\n]*/)||[''])[0],
    })""")
    page.screenshot(path=f'{OUT}/e2e-after-sync.png')

    after = server_pipes(d1_api)
    new_rows = [p for p in after if p['id'] not in before]
    check('queued records reached the database after reconnect', len(new_rows) >= 3,
          f'{len(new_rows)} new row(s) on server; queue now {after_state["queue"]}'
          + (f'; UI error: {after_state["body"]}' if after_state['body'] else ''))
    check('the queue drained', after_state['queue'] == 0, f'{after_state["queue"]} left')
    check('remarks survived the trip',
          any('OFFLINE PIPE' in (r.get('remarks') or '') for r in new_rows),
          str([r.get('remarks') for r in new_rows])[:100])

    # --- ADMIN SEES IT -------------------------------------------------------
    admin_rows = server_pipes(admin_api)
    visible = [r for r in admin_rows if r['id'] in {n['id'] for n in new_rows}]
    check('admin sees every record the crew synced',
          len(visible) == len(new_rows) and len(new_rows) > 0,
          f'admin sees {len(visible)}/{len(new_rows)} new + {len(admin_rows)} total')

    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
