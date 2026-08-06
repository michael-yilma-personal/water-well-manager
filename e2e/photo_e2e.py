"""Photo pipeline E2E: capture -> compress -> filesystem -> Storage upload."""
import json, urllib.request, sys, struct, zlib
from playwright.sync_api import sync_playwright

OUT = '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'
URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))


def make_big_png(path, w=4032, h=3024):
    """A genuinely large image, so compression has something to prove."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # PNG filter byte
        for x in range(w):
            raw.append((x * 7 + y * 13) % 256)
            raw.append((x * 3) % 256)
            raw.append((y * 5) % 256)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 1))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    return len(png)


def sign_in_api(email):
    req = urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password', method='POST')
    req.add_header('apikey', KEY); req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, json.dumps({'email': email, 'password': 'TestPass123!'}).encode()) as r:
        d = json.loads(r.read().decode())
        return d['access_token'], d['user']['id']


def list_photos(token, uid):
    req = urllib.request.Request(f'{URL}/storage/v1/object/list/drilling-photos', method='POST')
    req.add_header('apikey', KEY); req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Content-Type', 'application/json')
    body = json.dumps({'prefix': f'{uid}/', 'limit': 100}).encode()
    with urllib.request.urlopen(req, body) as r:
        return json.loads(r.read().decode())


src = f'{OUT}/big-photo.png'
size = make_big_png(src)
print(f'source image: {size/1024/1024:.1f} MB, 4032x3024\n')

d1_token, d1_uid = sign_in_api('driller1@example.com')
before = {o['name'] for o in list_photos(d1_token, d1_uid)}
print(f'{len(before)} object(s) in storage before\n')

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://localhost:3000', wait_until='networkidle'); page.wait_for_timeout(2000)

    page.fill('input[type="email"]', 'driller1@example.com')
    page.fill('input[type="password"]', 'TestPass123!')
    page.get_by_role('button', name='Link this device').click()
    page.wait_for_timeout(4000)

    # a real (non-demo) borehole so the event has a syncable parent
    page.evaluate("""() => {
      const bh = { id: crypto.randomUUID(), name: 'BH-PHOTO-E2E', project: 'Photo E2E',
        client: 'C', rigName: 'Rig #4', targetDepth: 100, currentDepth: 0,
        defaultPipeLength: 4.55, bitDiameter: 8.5, bitType: 'DTH Hammer - Button Bit',
        gpsCoordinates: {lat:0,lng:0}, status: 'active',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0, currentCompressorHours:0 };
      const l = JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]');
      l.unshift(bh); localStorage.setItem('wwdm_boreholes', JSON.stringify(l));
      localStorage.setItem('wwdm_active_borehole_id', bh.id);
    }""")
    page.reload(wait_until='networkidle'); page.wait_for_timeout(2500)

    ls_before = page.evaluate("() => JSON.stringify(localStorage).length")

    # --- attach the photo ----------------------------------------------------
    page.get_by_text('BREAKDOWN').first.click(); page.wait_for_timeout(1500)
    page.locator('.fixed.inset-0 input[type="file"]').set_input_files(src)

    # The worker auto-drains ~1.2s after enqueue, so watch for the photo
    # operation appearing rather than sampling once after it has already gone.
    saw_photo_op = False
    for _ in range(60):
        page.wait_for_timeout(150)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]')"
                         ".some(o => o.entity === 'photo')"):
            saw_photo_op = True
            break
    page.wait_for_timeout(4000)

    state = page.evaluate("""() => ({
      hasPreview: !!document.querySelector('.fixed.inset-0 img'),
      previewLen: (document.querySelector('.fixed.inset-0 img')||{}).src?.length || 0,
      queue: JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').filter(o=>o.entity==='photo').length,
      lsSize: JSON.stringify(localStorage).length,
    })""")
    check('photo produces a preview', state['hasPreview'])
    check('photo upload is queued as its own operation', saw_photo_op,
          'never observed a photo op in the queue')

    grew = state['lsSize'] - ls_before
    check('localStorage does NOT balloon with image bytes', grew < 200_000,
          f'grew {grew/1024:.0f} KB (a base64 copy would be ~4000 KB)')

    page.locator('.fixed.inset-0 input[type="text"]').fill('E2E photo event')
    page.get_by_text('SAVE FIELD EVENT').first.click()
    page.wait_for_timeout(2000)

    # --- sync ---------------------------------------------------------------
    # The worker drains on its own after each write, so nudge it only if there
    # is still work pending, then wait for the queue to clear.
    btn = page.locator('button[title*="sync"], button[title*="synchron"]').first
    if btn.count() and btn.is_enabled():
        btn.click()
    drained = False
    for _ in range(30):
        page.wait_for_timeout(1000)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length") == 0:
            drained = True
            break
    check('queue drains without manual intervention', drained)

    final = page.evaluate("""() => ({
      queue: JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length,
      err: (document.body.innerText.match(/Could not upload[^\\n]*/)||[''])[0],
    })""")
    page.screenshot(path=f'{OUT}/e2e-photo-synced.png')
    check('queue drained after sync', final['queue'] == 0,
          f"{final['queue']} left {final['err']}")

    objects = list_photos(d1_token, d1_uid)
    new = [o for o in objects if o['name'] not in before]
    full = [o for o in new if not o['name'].endswith('_thumb.jpg')]
    thumb = [o for o in new if o['name'].endswith('_thumb.jpg')]

    check('full-size photo reached storage', len(full) == 1, str([o['name'] for o in full]))
    check('thumbnail reached storage', len(thumb) == 1, str([o['name'] for o in thumb]))

    def sz(o):
        return (o.get('metadata') or {}).get('size', 0)

    if full and thumb:
        fs, ts = sz(full[0]), sz(thumb[0])
        check('full image compressed to a sane size', 20_000 < fs < 900_000,
              f'{fs/1024:.0f} KB (source was {size/1024/1024:.1f} MB)')
        check('thumbnail is far smaller, keeping egress down', ts < fs / 3,
              f'thumb {ts/1024:.0f} KB vs full {fs/1024:.0f} KB')

    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
