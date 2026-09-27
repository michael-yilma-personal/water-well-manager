"""Pausing a pipe must stop the drilling clock, report the stop, and resume cleanly."""
import os, sys, tempfile
from playwright.sync_api import sync_playwright
OUT = os.environ.get('E2E_OUT', tempfile.gettempdir())
results = []
def check(n, ok, d=''):
    results.append((n, ok)); print(f'{"PASS" if ok else "FAIL"}  {n}' + (f'   -- {d}' if d else ''))

TIMER = "() => { const m = JSON.parse(localStorage.getItem('wwdm_active_timer')||'{}'); return Object.values(m).find(t => t.isActive) || null }"
PAUSE_EVENTS = "() => JSON.parse(localStorage.getItem('wwdm_events')||'[]').filter(e => e.type === 'Drilling Paused')"
CLOCK = r"() => (document.body.innerText.match(/DRILLING TIME\s*\n\s*(\d\d:\d\d:\d\d)/i)||[])[1]"

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True)
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto('http://localhost:3000', wait_until='networkidle'); page.wait_for_timeout(2000)
    if 'link this device' in page.inner_text('body').lower():
        page.get_by_role('button', name='Work offline for now').click(); page.wait_for_timeout(2500)
    pipes_before = page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').length")
    pauses_before = len(page.evaluate(PAUSE_EVENTS))

    check('no PAUSE button before a pipe starts', page.get_by_text('PAUSE', exact=True).count() == 0)
    page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(2200)
    check('PAUSE is offered while drilling', page.get_by_text('PAUSE', exact=True).count() == 1)

    # --- pause
    page.get_by_text('PAUSE', exact=True).click(); page.wait_for_timeout(600)
    check('pause sheet asks for a reason', page.get_by_text('Waiting on fuel or water').count() == 1)
    page.fill('input[placeholder*="Fuel bowser"]', 'bowser late')
    page.get_by_text('Waiting on fuel or water').click(); page.wait_for_timeout(800)
    t = page.evaluate(TIMER)
    check('timer is paused', bool(t) and t['pauses'] and 'end' not in t['pauses'][-1], str(t and t.get('pauses')))
    check('RESUME DRILLING is shown', page.get_by_text('RESUME DRILLING').count() == 1)
    check('banner says paused', 'PIPE #' in page.inner_text('body').upper() and 'PAUSED' in page.inner_text('body').upper())
    check('END PIPE still available while paused', not page.locator('button:has-text("END PIPE")').is_disabled())
    ev = page.evaluate(PAUSE_EVENTS)
    check('a Drilling Paused event is logged at once', len(ev) == pauses_before + 1)
    open_ev = [e for e in ev if not e['details'].get('resumedAt')]
    check('it is open, with reason and note', len(open_ev) == 1 and open_ev[0]['details'].get('pauseReason') == 'Waiting on fuel or water'
          and open_ev[0]['details'].get('notes') == 'bowser late' and open_ev[0]['isNPT'], str(open_ev)[:160])
    outbox = page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_outbox')||'[]')")
    check('the pause is queued for upload immediately',
          any(i['entity'] == 'event' and i['entityId'] == open_ev[0]['id'] for i in outbox) if open_ev else False)
    clock1 = page.evaluate(CLOCK); page.wait_for_timeout(2500); clock2 = page.evaluate(CLOCK)
    check('drilling clock is frozen while paused', clock1 is not None and clock1 == clock2, f'{clock1} -> {clock2}')
    page.screenshot(path=f'{OUT}/pause-paused.png')

    # --- resume
    page.get_by_text('RESUME DRILLING').click(); page.wait_for_timeout(2500)
    t = page.evaluate(TIMER)
    check('resume closes the pause', bool(t) and all('end' in x for x in t['pauses']))
    clock3 = page.evaluate(CLOCK)
    check('drilling clock runs again', clock3 is not None and clock3 > clock2, f'{clock2} -> {clock3}')
    closed = [e for e in page.evaluate(PAUSE_EVENTS) if e['id'] == open_ev[0]['id']][0]
    check('pause event gains resumedAt and a duration', bool(closed['details'].get('resumedAt')) and closed.get('durationMinutes', 0) >= 1, str(closed)[:160])

    # --- pause again, then END PIPE while paused
    page.get_by_text('PAUSE', exact=True).click(); page.wait_for_timeout(500)
    page.get_by_text('Weather', exact=True).click(); page.wait_for_timeout(1500)
    page.click('button:has-text("END PIPE")'); page.wait_for_timeout(500)
    check('End Pipe sheet shows the pauses', 'PAUSED 2 TIMES' in page.inner_text('body').upper())
    page.screenshot(path=f'{OUT}/pause-endpipe.png')
    page.click('button:has-text("SAVE PIPE RECORD")'); page.wait_for_timeout(800)

    recs = page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]')")
    check('pipe was saved', len(recs) == pipes_before + 1)
    r = recs[-1]
    wall = (__import__('datetime').datetime.fromisoformat(r['endTime'].replace('Z', '+00:00')) -
            __import__('datetime').datetime.fromisoformat(r['startTime'].replace('Z', '+00:00'))).total_seconds()
    check('record carries both pauses, all closed', len(r.get('pauses', [])) == 2 and all(x.get('end') for x in r['pauses']), str(r.get('pauses'))[:160])
    check('paused time is left out of drilling time', r['pausedSeconds'] > 0 and r['durationSeconds'] < wall,
          f"drill={r['durationSeconds']} paused={r['pausedSeconds']} wall={wall:.0f}")
    ev = page.evaluate(PAUSE_EVENTS)
    check('ending while paused closes the second pause event', len(ev) == pauses_before + 2 and all(e['details'].get('resumedAt') for e in ev[:2]))
    check('timer is idle again', page.evaluate(TIMER) is None)
    check('PAUSE button gone after END PIPE', page.get_by_text('PAUSE', exact=True).count() == 0)
    check('no JS errors', not errs, str(errs[:2]))
    b.close()
print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
