"""Admin dashboard E2E against live Supabase."""
import json, urllib.request, sys, os
from playwright.sync_api import sync_playwright

OUT = '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'
URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

def sign_in_api(email):
    req = urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password', method='POST')
    req.add_header('apikey', KEY); req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, json.dumps({'email': email, 'password': 'TestPass123!'}).encode()) as r:
        d = json.loads(r.read().decode()); return d['access_token'], d['user']['id']

def api(path, token):
    req = urllib.request.Request(URL + path)
    req.add_header('apikey', KEY); req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())

admin_token, _ = sign_in_api('admin1@example.com')
d1_token, _ = sign_in_api('driller1@example.com')
all_bh = api('/rest/v1/boreholes?select=id,name', admin_token)
d1_bh = api('/rest/v1/boreholes?select=id,name', d1_token)
print(f'server: {len(all_bh)} borehole(s) total, {len(d1_bh)} owned by driller1\n')

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://localhost:3000/admin.html', wait_until='networkidle')
    page.wait_for_timeout(2000)

    check('dashboard asks for sign-in', 'Administrator sign-in' in page.inner_text('body'),
          page.inner_text('body')[:60].replace('\n', ' | '))

    page.fill('input[type="email"]', 'admin1@example.com')
    page.fill('input[type="password"]', 'TestPass123!')
    page.get_by_role('button', name='Sign in').click()
    page.wait_for_timeout(6000)

    body = page.inner_text('body')
    check('borehole list renders', 'Every borehole reported from the field' in body,
          body[:80].replace('\n', ' | '))
    rows = page.evaluate("() => document.querySelectorAll('tbody tr').length")
    check('admin sees every crew\'s boreholes', rows >= len(all_bh),
          f'{rows} row(s) in table vs {len(all_bh)} on server')
    check('admin sees MORE than one crew owns', len(all_bh) > len(d1_bh),
          f'{len(all_bh)} total vs {len(d1_bh)} for driller1')
    page.screenshot(path=f'{OUT}/dash-list.png', full_page=False)

    # search
    page.fill('input[placeholder*="Search"]', 'OFFLINE')
    page.wait_for_timeout(1200)
    filtered = page.evaluate("() => document.querySelectorAll('tbody tr').length")
    check('search filters the list', filtered < rows and filtered > 0, f'{rows} -> {filtered}')
    page.fill('input[placeholder*="Search"]', '')
    page.wait_for_timeout(1000)

    # open a borehole that actually has pipe records
    target = None
    for b in all_bh:
        pipes = api(f"/rest/v1/pipe_records?select=id&borehole_id=eq.{b['id']}", admin_token)
        if len(pipes) >= 2:
            target = (b, len(pipes))
            break
    check('found a borehole with pipe records to open', target is not None)

    if target:
        b, n = target
        page.get_by_text(b['name'], exact=False).first.click()
        page.wait_for_timeout(4000)
        detail = page.inner_text('body')
        check('detail view opens', 'pipe log' in detail.lower(), detail[:70].replace('\n', ' | '))
        prow = page.evaluate("() => document.querySelectorAll('tbody tr').length")
        check('pipe log lists the records', prow >= n, f'{prow} row(s), server has {n}')
        check('measured depth is shown', 'measured depth' in detail.lower())
        page.screenshot(path=f'{OUT}/dash-detail.png', full_page=False)

        # exports must work from the dashboard
        for label, ext in [('Excel', '.xlsx'), ('PDF', '.pdf')]:
            try:
                with page.expect_download(timeout=25000) as dl:
                    page.get_by_role('button', name=label).click()
                d = dl.value
                sz = os.path.getsize(d.path())
                check(f'{label} export downloads', sz > 5000, f'{d.suggested_filename} {sz/1024:.0f} KB')
            except Exception as e:
                check(f'{label} export downloads', False, str(e)[:80])

    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
