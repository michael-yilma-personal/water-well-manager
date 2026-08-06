"""Sync + photo pipeline on the real Android APK, against live Supabase."""
import json, urllib.request, sys, subprocess, time
sys.path.insert(0, '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad')
from apk import apk_page, OUT

URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'
ADB = '/Users/kalena/Library/Android/sdk/platform-tools/adb'

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

def api(path, token):
    req = urllib.request.Request(URL + path)
    req.add_header('apikey', KEY); req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

def sign_in_api(email):
    req = urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password', method='POST')
    req.add_header('apikey', KEY); req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, json.dumps({'email': email, 'password': 'TestPass123!'}).encode()) as r:
        d = json.loads(r.read().decode()); return d['access_token'], d['user']['id']

d1_token, d1_uid = sign_in_api('driller1@example.com')
admin_token, _ = sign_in_api('admin1@example.com')
before_pipes = {p['id'] for p in api('/rest/v1/pipe_records?select=id', d1_token)}
print(f'{len(before_pipes)} pipe record(s) on server before\n')

with apk_page() as (page, logs):
    body = page.inner_text('body')
    # A device that has been linked before never shows this again - that is the
    # whole point of provisioning once, so the suite must tolerate both states.
    needs_link = 'link this device' in body.lower()
    if needs_link:
        page.fill('input[type="email"]', 'driller1@example.com')
        page.fill('input[type="password"]', 'TestPass123!')
        page.get_by_role('button', name='Link this device').click()
        page.wait_for_timeout(6000)
    else:
        print('  (device already linked; skipping sign-in)')
    # Linking clears the seeded sample job, so a freshly linked device lands on
    # the empty state rather than a fake borehole.
    linked = page.inner_text('body')
    check('device is linked and usable',
          'CURRENT DEPTH' in linked or 'No borehole on this device yet' in linked,
          linked[:70].replace('\n', ' | '))
    page.screenshot(path=f'{OUT}/apk-signed-in.png')

    # the Capacitor plugins the worker depends on must actually be present
    plugins = page.evaluate("() => Object.keys(window.Capacitor?.Plugins || {})")
    check('Network plugin registered in the APK', 'Network' in plugins, str(plugins))
    check('Filesystem plugin registered in the APK', 'Filesystem' in plugins)

    # a real borehole to hang records off
    page.evaluate("""() => {
      const bh = { id: crypto.randomUUID(), name:'BH-APK-E2E', project:'APK E2E', client:'C',
        rigName:'Rig #4', targetDepth:100, currentDepth:0, defaultPipeLength:4.55,
        bitDiameter:8.5, bitType:'DTH Hammer - Button Bit', gpsCoordinates:{lat:0,lng:0},
        status:'active', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
        engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0, currentCompressorHours:0 };
      const l = JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]'); l.unshift(bh);
      localStorage.setItem('wwdm_boreholes', JSON.stringify(l));
      localStorage.setItem('wwdm_active_borehole_id', bh.id);
    }""")
    page.reload(wait_until='networkidle'); page.wait_for_timeout(3000)

    # --- airplane mode: genuinely offline at the OS level -------------------
    subprocess.run([ADB, 'shell', 'svc', 'wifi', 'disable'], capture_output=True)
    subprocess.run([ADB, 'shell', 'svc', 'data', 'disable'], capture_output=True)
    time.sleep(4)

    for i in range(2):
        page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(900)
        page.get_by_text('END PIPE', exact=True).click(); page.wait_for_timeout(1100)
        page.locator('input[placeholder*="Quartzite"], textarea[placeholder*="Quartzite"]').first.fill(
            f'APK OFFLINE PIPE {i+1}')
        page.get_by_text('SAVE PIPE RECORD').click(); page.wait_for_timeout(1500)

    offline = page.evaluate("""() => ({
      queue: JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length,
      pipes: JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').filter(p=>!p.isDemo).length,
    })""")
    check('APK captures records with radios off', offline['pipes'] >= 2,
          f"{offline['pipes']} local pipe(s)")
    check('work is queued while offline', offline['queue'] >= 2, f"{offline['queue']} queued")
    page.screenshot(path=f'{OUT}/apk-offline.png')

    mid = {p['id'] for p in api('/rest/v1/pipe_records?select=id', d1_token)}
    check('nothing leaked to the server while offline', mid == before_pipes)

    # --- radios back on -----------------------------------------------------
    subprocess.run([ADB, 'shell', 'svc', 'wifi', 'enable'], capture_output=True)
    subprocess.run([ADB, 'shell', 'svc', 'data', 'enable'], capture_output=True)
    time.sleep(10)

    drained = False
    for _ in range(40):
        page.wait_for_timeout(1500)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length") == 0:
            drained = True
            break
    q = page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').map(o=>o.entity+':'+(o.lastError||'').slice(0,60))")
    check('queue drains once the radios come back', drained, str(q))
    page.screenshot(path=f'{OUT}/apk-after-sync.png')

    after = api('/rest/v1/pipe_records?select=id,remarks', d1_token)
    new = [p for p in after if p['id'] not in before_pipes]
    check('APK records reached the database', len(new) >= 2, f'{len(new)} new row(s)')
    check('remarks intact', any('APK OFFLINE' in (r.get('remarks') or '') for r in new),
          str([r.get('remarks') for r in new])[:90])

    admin_rows = api('/rest/v1/pipe_records?select=id', admin_token)
    check('admin sees the APK records',
          len([r for r in admin_rows if r['id'] in {n['id'] for n in new}]) == len(new))

    errs = [l for l in logs if 'pageerror' in l]
    check('no JS errors on device', not errs, str(errs[:2]))

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
