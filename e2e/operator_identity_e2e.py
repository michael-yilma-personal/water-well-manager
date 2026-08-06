"""The name on a pipe record must be the account that logged it.

The operator name used to come from a local picker seeded with three fictional
people, so a real driller's work was credited to "James Wanjala" while
created_by recorded the true account. The drilling log and the audit trail
disagreed about who did the work - on a log that backs client billing.
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

OUT = '/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'
URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'

DRILLER = ('driller2@example.com', 'TestPass123!')
EXPECTED_NAME = 'Peter Otieno'

results = []
def check(name, ok, detail=''):
    results.append((name, ok))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''))

def token(email, password):
    r = urllib.request.Request(f'{URL}/auth/v1/token?grant_type=password', method='POST')
    r.add_header('apikey', KEY); r.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(r, json.dumps({'email': email, 'password': password}).encode()) as x:
        return json.loads(x.read().decode())['access_token']

def api(path, tok):
    q = urllib.request.Request(URL + path)
    q.add_header('apikey', KEY); q.add_header('Authorization', f'Bearer {tok}')
    return json.loads(urllib.request.urlopen(q).read().decode())

tok = token(*DRILLER)
before = {p['id'] for p in api('/rest/v1/pipe_records?select=id', tok)}

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://localhost:3000', wait_until='networkidle')
    page.wait_for_timeout(2000)

    page.fill('input[type="email"]', DRILLER[0])
    page.fill('input[type="password"]', DRILLER[1])
    page.get_by_role('button', name='Link this device').click()
    page.wait_for_timeout(7000)

    identity = page.evaluate("""() => {
      const users = JSON.parse(localStorage.getItem('wwdm_users') || '[]');
      return { count: users.length, names: users.map(u => u.name) };
    }""")
    check('the fictional sample operators are gone', 'James Wanjala' not in identity['names'],
          str(identity))
    check('the signed-in account is the only operator',
          identity['count'] == 1 and identity['names'] == [EXPECTED_NAME], str(identity))

    # a real borehole to log against
    page.evaluate("""() => {
      const bh = { id: crypto.randomUUID(), name:'BH-IDENTITY', project:'Identity', client:'C',
        rigName:'Rig #1', targetDepth:100, currentDepth:0, defaultPipeLength:4.55,
        bitDiameter:8.5, bitType:'DTH', gpsCoordinates:{lat:0,lng:0}, status:'active',
        createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
        engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0, currentCompressorHours:0 };
      const l = JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]'); l.unshift(bh);
      localStorage.setItem('wwdm_boreholes', JSON.stringify(l));
      localStorage.setItem('wwdm_active_borehole_id', bh.id);
    }""")
    page.reload(wait_until='networkidle'); page.wait_for_timeout(3500)

    # The header only exists once a borehole does; straight after linking the
    # device correctly shows the empty state instead.
    check('the header shows the real person', EXPECTED_NAME in page.inner_text('body'),
          page.inner_text('body')[:80].replace('\n', ' | '))
    page.screenshot(path=f'{OUT}/identity-header.png')

    page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(900)
    page.get_by_text('END PIPE', exact=True).click(); page.wait_for_timeout(1100)
    page.get_by_text('SAVE PIPE RECORD').click(); page.wait_for_timeout(2000)

    local_op = page.evaluate("""() => {
      const p = JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]');
      return p.length ? p[p.length-1].operator : null;
    }""")
    check('the record is stamped with the real operator', local_op == EXPECTED_NAME, str(local_op))

    for _ in range(30):
        page.wait_for_timeout(1200)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length") == 0:
            break

    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

rows = api('/rest/v1/pipe_records?select=id,operator,created_by', tok)
new = [r for r in rows if r['id'] not in before]
check('the record reached the server', len(new) >= 1, f'{len(new)} new row(s)')

if new:
    prof = api(f"/rest/v1/profiles?select=name&id=eq.{new[0]['created_by']}", tok)
    account_name = prof[0]['name'] if prof else None
    check('operator on the server matches the account that synced it',
          new[0]['operator'] == account_name == EXPECTED_NAME,
          f"operator={new[0]['operator']!r} account={account_name!r}")

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
