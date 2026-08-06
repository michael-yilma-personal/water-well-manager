"""Photo capture on the real Android APK: compress -> Filesystem -> Storage."""
import json, urllib.request, sys, base64, struct, zlib
sys.path.insert(0, '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad')
from apk import apk_page, OUT

URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

def make_png(w=2400, h=1800):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw.append((x * 7 + y * 13) % 256)
            raw.append((x * 3) % 256)
            raw.append((y * 5) % 256)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 1))
            + chunk(b'IEND', b''))

def sign_in_api(email):
    req = urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password', method='POST')
    req.add_header('apikey', KEY); req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, json.dumps({'email': email, 'password': 'TestPass123!'}).encode()) as r:
        d = json.loads(r.read().decode()); return d['access_token'], d['user']['id']

def list_photos(token, uid):
    req = urllib.request.Request(f'{URL}/storage/v1/object/list/drilling-photos', method='POST')
    req.add_header('apikey', KEY); req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, json.dumps({'prefix': f'{uid}/', 'limit': 200}).encode()) as r:
        return json.loads(r.read().decode())

png_b64 = base64.b64encode(make_png()).decode()
print(f'source image: {len(png_b64)*3//4/1024/1024:.1f} MB, 2400x1800\n')

d1_token, d1_uid = sign_in_api('driller1@example.com')
before = {o['name'] for o in list_photos(d1_token, d1_uid)}
print(f'{len(before)} object(s) in storage before\n')

with apk_page() as (page, logs):
    body = page.inner_text('body')
    if 'link this device' in body.lower():
        page.fill('input[type="email"]', 'driller1@example.com')
        page.fill('input[type="password"]', 'TestPass123!')
        page.get_by_role('button', name='Link this device').click()
        page.wait_for_timeout(6000)
    check('device is linked', 'CURRENT DEPTH' in page.inner_text('body'))

    ls_before = page.evaluate("() => JSON.stringify(localStorage).length")

    page.get_by_text('BREAKDOWN').first.click()
    page.wait_for_timeout(1800)
    check('event modal opens on device', 'BREAKDOWN OPERATION' in page.inner_text('body'))

    # Playwright cannot push a host file into an Android WebView's file input,
    # so build the File in-page. This still exercises the real path: canvas
    # compression, Capacitor Filesystem writes on Android, and the upload queue.
    page.evaluate("""(b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'site.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('.fixed.inset-0 input[type="file"]');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }""", png_b64)

    saw_photo_op = False
    for _ in range(80):
        page.wait_for_timeout(200)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').some(o=>o.entity==='photo')"):
            saw_photo_op = True
            break
    check('photo queued as its own upload on device', saw_photo_op)

    page.wait_for_timeout(3000)
    state = page.evaluate("""() => ({
      preview: !!document.querySelector('.fixed.inset-0 img'),
      ls: JSON.stringify(localStorage).length,
    })""")
    check('preview renders on device', state['preview'])
    grew = state['ls'] - ls_before
    check('localStorage does not balloon on device', grew < 200_000,
          f'grew {grew/1024:.0f} KB')
    page.screenshot(path=f'{OUT}/apk-photo-attached.png')

    page.locator('.fixed.inset-0 input[type="text"]').fill('APK photo event')
    page.get_by_text('SAVE FIELD EVENT').first.click()
    page.wait_for_timeout(2500)

    drained = False
    for _ in range(50):
        page.wait_for_timeout(1500)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length") == 0:
            drained = True
            break
    q = page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').map(o=>o.entity+':'+(o.lastError||'').slice(0,70))")
    check('queue drains on device', drained, str(q))
    page.screenshot(path=f'{OUT}/apk-photo-synced.png')

    objects = list_photos(d1_token, d1_uid)
    new = [o for o in objects if o['name'] not in before]
    full = [o for o in new if not o['name'].endswith('_thumb.jpg')]
    thumb = [o for o in new if o['name'].endswith('_thumb.jpg')]
    check('full photo uploaded from device', len(full) == 1, str([o['name'][-24:] for o in full]))
    check('thumbnail uploaded from device', len(thumb) == 1)
    if full and thumb:
        fs = (full[0].get('metadata') or {}).get('size', 0)
        ts = (thumb[0].get('metadata') or {}).get('size', 0)
        check('compressed on device', 10_000 < fs < 900_000, f'{fs/1024:.0f} KB')
        check('thumbnail much smaller', ts < fs / 3, f'thumb {ts/1024:.0f} KB vs {fs/1024:.0f} KB')

    errs = [l for l in logs if 'pageerror' in l]
    check('no JS errors on device', not errs, str(errs[:2]))

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
