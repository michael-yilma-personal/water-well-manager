"""The journey a brand-new crew actually takes: link, create, log, sync."""
import json, urllib.request, sys
from playwright.sync_api import sync_playwright
OUT='/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'
URL='https://bfteveoeodbvjxjlpnwz.supabase.co'; KEY='sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'
results=[]
def check(n, ok, d=''):
    results.append((n,ok)); print(f'{"PASS" if ok else "FAIL"}  {n}'+(f'   -- {d}' if d else ''))
def sign_in(email):
    r=urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password',method='POST')
    r.add_header('apikey',KEY); r.add_header('Content-Type','application/json')
    with urllib.request.urlopen(r, json.dumps({'email':email,'password':'TestPass123!'}).encode()) as x:
        return json.loads(x.read().decode())['access_token']
def api(p, t):
    q=urllib.request.Request(URL+p); q.add_header('apikey',KEY); q.add_header('Authorization',f'Bearer {t}')
    return json.loads(urllib.request.urlopen(q).read().decode())

tok=sign_in('driller2@example.com')
before={b['id'] for b in api('/rest/v1/boreholes?select=id', tok)}

with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':411,'height':900}, is_mobile=True)
    page=ctx.new_page(); errs=[]
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://localhost:3000', wait_until='networkidle'); page.wait_for_timeout(2000)
    page.fill('input[type="email"]','driller2@example.com')
    page.fill('input[type="password"]','TestPass123!')
    page.get_by_role('button', name='Link this device').click(); page.wait_for_timeout(6000)
    check('new crew sees an empty-state prompt, not a crash',
          'No borehole on this device yet' in page.inner_text('body'))

    page.get_by_role('button', name='Create a borehole').click(); page.wait_for_timeout(2000)
    check('create-borehole modal opens', page.locator('.fixed.inset-0').count() > 0)
    inputs = page.locator('.fixed.inset-0 input[type="text"]')
    n = inputs.count()
    for i in range(min(n, 4)):
        inputs.nth(i).fill(['BH-NEWCREW-01','Newcrew Project','Newcrew Client','Rig #1'][i] if i < 4 else 'x')
    page.screenshot(path=f'{OUT}/newcrew-form.png')
    btn=[t for t in ['CREATE BOREHOLE','SAVE','CREATE'] if page.get_by_text(t).count()]
    if btn: page.get_by_text(btn[0]).first.click()
    page.wait_for_timeout(3000)
    check('rig UI appears after creating the first borehole',
          'CURRENT DEPTH' in page.inner_text('body'), page.inner_text('body')[:70].replace('\n',' | '))

    page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(900)
    page.get_by_text('END PIPE', exact=True).click(); page.wait_for_timeout(1100)
    page.get_by_text('SAVE PIPE RECORD').click(); page.wait_for_timeout(2000)

    drained=False
    for _ in range(30):
        page.wait_for_timeout(1200)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length")==0:
            drained=True; break
    check('first records sync', drained,
          str(page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').map(o=>o.entity+':'+(o.lastError||''))")))
    after=api('/rest/v1/boreholes?select=id,name', tok)
    new=[x for x in after if x['id'] not in before]
    check('the new borehole reached the database', len(new)>=1, str([x['name'] for x in new]))
    check('no JS errors', not errs, str(errs[:2]))
    page.screenshot(path=f'{OUT}/newcrew-done.png')
    b.close()
print(f'\n{sum(1 for _,ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _,ok in results) else 1)
