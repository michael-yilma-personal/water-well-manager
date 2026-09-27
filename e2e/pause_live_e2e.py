"""Pause and resume, end to end against the live Supabase project.

A driller pauses a pipe in the field app; the office must see the rig paused
on the admin dashboard before the pipe is finished, see it resume, and then see
the finished pipe with its paused time taken out of the drilling time.

Uses the example.com test accounts (driller1, admin1): create them with
scripts/create-user.sh first and remove them with scripts/delete-test-data.sh.
"""
import json
import os
import sys
import tempfile
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

OUT = os.environ.get('E2E_OUT', tempfile.gettempdir())
URL = 'https://bfteveoeodbvjxjlpnwz.supabase.co'
KEY = 'sb_publishable_7lHYQcJ4rNaIIG4UhmV9YQ_jIRdGn2l'
APP = 'http://localhost:3000'
DRILLER = ('driller1@example.com', 'TestPass123!')
ADMIN = ('admin1@example.com', 'TestPass123!')
BH_NAME = f'BH-PAUSE-{int(time.time()) % 100000}'

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

def drain(page):
    for _ in range(40):
        page.wait_for_timeout(1000)
        if page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]').length") == 0:
            return True
    return False

admin_tok = token(*ADMIN)

with sync_playwright() as p:
    browser = p.chromium.launch()
    field = browser.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True).new_page()
    office = browser.new_context(viewport={'width': 1400, 'height': 900}).new_page()
    errs = []
    field.on('pageerror', lambda e: errs.append(str(e)))
    office.on('pageerror', lambda e: errs.append(str(e)))
    field.on('dialog', lambda d: d.accept())

    # --- driller links the device and opens a real borehole
    field.goto(APP, wait_until='networkidle'); field.wait_for_timeout(2000)
    field.fill('input[type="email"]', DRILLER[0]); field.fill('input[type="password"]', DRILLER[1])
    field.get_by_role('button', name='Link this device').click(); field.wait_for_timeout(7000)
    bh_id = field.evaluate("""(name) => {
      const bh = { id: crypto.randomUUID(), name, project:'Pause test', client:'C',
        rigName:'Rig #1', targetDepth:100, currentDepth:0, defaultPipeLength:4.55,
        bitDiameter:8.5, bitType:'DTH', gpsCoordinates:{lat:0,lng:0}, status:'active',
        createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
        engineHoursStart:0, compressorHoursStart:0, currentEngineHours:0, currentCompressorHours:0 };
      const l = JSON.parse(localStorage.getItem('wwdm_boreholes')||'[]'); l.unshift(bh);
      localStorage.setItem('wwdm_boreholes', JSON.stringify(l));
      localStorage.setItem('wwdm_active_borehole_id', bh.id);
      return bh.id;
    }""", BH_NAME)
    field.reload(wait_until='networkidle'); field.wait_for_timeout(3500)

    # --- start, then pause
    field.get_by_text('START PIPE', exact=True).click(); field.wait_for_timeout(1500)
    field.get_by_text('PAUSE', exact=True).click(); field.wait_for_timeout(500)
    field.fill('input[placeholder*="Fuel bowser"]', 'live test note')
    field.get_by_text('Waiting on fuel or water').click()
    check('pause uploads without waiting for END PIPE', drain(field))

    ev_q = f'/rest/v1/drilling_events?select=*&borehole_id=eq.{bh_id}&type=eq.Drilling%20Paused&order=occurred_at'
    evs = api(ev_q, admin_tok)
    check('server has one open Drilling Paused event',
          len(evs) == 1 and not (evs[0]['details'] or {}).get('resumedAt') and evs[0]['is_npt'], str(evs)[:200])
    check('it carries reason, note and pipe number',
          bool(evs) and evs[0]['details'].get('pauseReason') == 'Waiting on fuel or water'
          and evs[0]['details'].get('notes') == 'live test note' and evs[0]['details'].get('pipeNumber') == 1)
    # The exact filter the dashboard's fetchOngoingPauses sends.
    ongoing = api('/rest/v1/drilling_events?select=borehole_id&type=eq.Drilling%20Paused'
                  '&deleted_at=is.null&details->>resumedAt=is.null', admin_tok)
    check('the dashboard query finds this rig as paused', any(r['borehole_id'] == bh_id for r in ongoing))

    # --- the office sees it while the rig is still paused
    office.goto(f'{APP}/admin.html', wait_until='networkidle'); office.wait_for_timeout(1500)
    office.fill('input[type="email"]', ADMIN[0]); office.fill('input[type="password"]', ADMIN[1])
    office.get_by_role('button', name='Sign in').click(); office.wait_for_timeout(4000)
    row = office.locator('tr', has_text=BH_NAME)
    check('borehole list shows PAUSED badge', row.count() == 1 and 'PAUSED SINCE' in row.inner_text().upper(),
          row.inner_text()[:120] if row.count() else 'row missing')
    office.screenshot(path=f'{OUT}/admin-list-paused.png')
    row.click(); office.wait_for_timeout(2500)
    body = office.inner_text('body')
    check('borehole page shows the paused banner',
          'Drilling paused on pipe #1' in body and 'Waiting on fuel or water' in body)
    check('downtime table marks the pause ongoing', 'ONGOING' in body.upper())
    office.screenshot(path=f'{OUT}/admin-detail-paused.png', full_page=True)

    # --- resume, pause again, end the pipe while paused
    field.wait_for_timeout(61000)  # so the first pause is a real minute
    field.get_by_text('RESUME DRILLING').click()
    check('resume uploads', drain(field))
    evs = api(ev_q, admin_tok)
    check('server pause event now has resumedAt and a duration',
          len(evs) == 1 and evs[0]['details'].get('resumedAt') and (evs[0]['duration_minutes'] or 0) >= 1, str(evs)[:200])
    field.wait_for_timeout(3000)
    field.get_by_text('PAUSE', exact=True).click(); field.wait_for_timeout(500)
    field.get_by_text('Weather', exact=True).click(); field.wait_for_timeout(2000)
    field.get_by_text('END PIPE', exact=True).click(); field.wait_for_timeout(900)
    field.get_by_text('SAVE PIPE RECORD').click()
    check('finished pipe uploads', drain(field))

    pipes = api(f'/rest/v1/pipe_records?select=*&borehole_id=eq.{bh_id}', admin_tok)
    pr = pipes[0] if pipes else {}
    check('server pipe row carries both pauses', len(pr.get('pauses') or []) == 2, str(pr.get('pauses'))[:200])
    check('server pipe row has paused time out of drilling time',
          (pr.get('paused_seconds') or 0) >= 60 and pr.get('duration_seconds', 999) < 60,
          f"drill={pr.get('duration_seconds')} paused={pr.get('paused_seconds')}")
    evs = api(ev_q, admin_tok)
    check('both pause events are closed on the server',
          len(evs) == 2 and all(e['details'].get('resumedAt') for e in evs))

    # --- the office sees the finished pipe and no longer a paused rig
    office.get_by_text('All boreholes').click(); office.wait_for_timeout(3000)
    row = office.locator('tr', has_text=BH_NAME)
    check('PAUSED badge is gone once drilling finished', 'PAUSED SINCE' not in row.inner_text().upper())
    row.click(); office.wait_for_timeout(2500)
    pipe_row = office.locator('tr', has_text='#1').first.inner_text()
    check('pipe log shows paused time', '(2×)' in pipe_row, pipe_row.replace('\t', ' | ')[:160])
    office.screenshot(path=f'{OUT}/admin-detail-done.png', full_page=True)

    check('no JS errors', not errs, str(errs[:2]))
    browser.close()

print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
