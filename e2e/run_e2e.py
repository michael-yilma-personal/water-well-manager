"""End-to-end regression suite for the Water Well Drilling Manager.

Boots the dev server, drives the real UI with Playwright and asserts against the
persisted localStorage state. Run with:  npm run test:e2e

Requires:  pip install playwright && playwright install chromium
"""
import os
import re
import signal
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PORT', '3000'))
URL = f'http://localhost:{PORT}'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0


def start_server():
    """Start `npm run dev` unless something is already serving the port."""
    if port_open(PORT):
        print(f'Reusing server already listening on {PORT}')
        return None
    proc = subprocess.Popen(
        ['npm', 'run', 'dev', '--', f'--port={PORT}'], cwd=ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(120):
        if port_open(PORT):
            print(f'Dev server ready on {PORT}')
            return proc
        if proc.poll() is not None:
            sys.exit('Dev server exited before becoming ready')
        time.sleep(0.5)
    stop_server(proc)
    sys.exit(f'Dev server did not come up on {PORT}')


def stop_server(proc):
    if proc is None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


results = []
runtime_errors = []
console_errors = []


def check(section, label, cond, detail=''):
    results.append((section, label, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f'   [{detail}]' if detail else ''))


def section(name):
    print(f'\n=== {name} ===')
    return name


server = start_server()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={'width': 1280, 'height': 1100}, accept_downloads=True)
        page = ctx.new_page()
        page.on('dialog', lambda d: d.accept())
        page.on('pageerror', lambda e: runtime_errors.append(str(e)))
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)

        page.goto(URL)
        page.wait_for_load_state('networkidle')

        ls = lambda key: page.evaluate(
            "(k) => { const v = localStorage.getItem(k); if (v === null) return null;"
            "  try { return JSON.parse(v); } catch { return v; } }", key)
        pipes = lambda bh='bh-2026-04': [r for r in (ls('wwdm_pipe_records') or []) if r['boreholeId'] == bh]
        events = lambda bh='bh-2026-04': [e for e in (ls('wwdm_events') or []) if e['boreholeId'] == bh]
        bh_of = lambda i: next((b for b in (ls('wwdm_boreholes') or []) if b['id'] == i), None)

        def goto_tab(name):
            if page.locator('div.fixed.inset-0').count():
                close_modals()
            page.locator(f'button:has-text("{name}")').last.click()
            page.wait_for_timeout(500)

        def drill_pipe(remark=None, strike=False):
            page.click('button:has-text("START PIPE")')
            page.wait_for_timeout(1100)
            page.click('button:has-text("END PIPE")')
            page.wait_for_timeout(400)
            if strike:
                page.get_by_role('button', name='NO', exact=True).click()
                page.wait_for_timeout(150)
            if remark:
                page.fill('input[placeholder*="Hard Quartzite"]', remark)
            page.click('button:has-text("SAVE PIPE RECORD")')
            page.wait_for_timeout(500)

        def close_modals():
            for _ in range(3):
                if page.locator('div.fixed.inset-0').count() == 0:
                    break
                page.locator('div.fixed.inset-0').last.locator('button:has(svg.lucide-x)').first.click()
                page.wait_for_timeout(300)

        def open_settings():
            goto_tab('Rig Control')
            page.click('button:has-text("CONFIGURE")')
            page.wait_for_timeout(400)

        # ---------------------------------------------------------------- boot
        s = section('1. Boot & seeded data')
        check(s, 'app shell rendered', page.locator('button:has-text("START PIPE")').count() == 1)
        check(s, 'seeded 2 boreholes', len(ls('wwdm_boreholes') or []) == 2)
        check(s, 'seeded 19 pipes', len(pipes()) == 19, str(len(pipes())))
        check(s, 'seeded 3 users', len(ls('wwdm_users') or []) == 3)
        check(s, 'all seeded pipes have ids', all(r.get('id') for r in pipes()))
        check(s, 'active borehole selected', ls('wwdm_active_borehole_id') == 'bh-2026-04')

        # ---------------------------------------------------------------- nav
        s = section('2. Navigation')
        for tab, marker in [('Pipe Log', 'input[placeholder*="Search pipe"]'),
                            ('NPT / Events', 'button:has-text("LOG NEW EVENT"), button:has-text("BREAKDOWN")'),
                            ('Analytics', 'svg.recharts-surface'),
                            ('Rig Control', 'button:has-text("START PIPE")')]:
            goto_tab(tab)
            check(s, f'{tab} tab renders', page.locator(marker).count() > 0)

        # ---------------------------------------------------------------- drilling
        s = section('3. Drilling cycle')
        goto_tab('Rig Control')
        check(s, 'END PIPE inert before START', page.locator('button:has-text("END PIPE")').is_disabled())
        page.click('button:has-text("START PIPE")')
        page.wait_for_timeout(1100)
        check(s, 'START disabled while running', page.locator('button:has-text("START PIPE")').is_disabled())
        check(s, 'END enabled while running', not page.locator('button:has-text("END PIPE")').is_disabled())
        check(s, 'live timer visible', page.locator('text=/00:00:0[0-9]/').count() > 0)
        page.click('button:has-text("END PIPE")')
        page.wait_for_timeout(400)
        page.get_by_role('button', name='NO', exact=True).click()
        page.fill('input[placeholder*="Hard Quartzite"]', 'pipe A remark')
        page.click('button:has-text("SAVE PIPE RECORD")')
        page.wait_for_timeout(500)
        drill_pipe(remark='pipe B remark')
        drill_pipe()

        recs = pipes()
        last3 = recs[-3:]
        check(s, 'three pipes appended', len(recs) == 22, f'19 -> {len(recs)}')
        check(s, 'sequential numbering', [r['pipeNumber'] for r in last3] == [20, 21, 22])
        check(s, 'unique ids', len({r['id'] for r in recs}) == len(recs))
        check(s, 'durations recorded', all(r.get('durationSeconds') for r in last3))
        check(s, 'rates recorded', all(r.get('penetrationRate') for r in last3))
        check(s, 'operator recorded', all(r.get('operator') for r in last3))
        check(s, 'water strike only on pipe A', [r['waterStrike'] for r in last3] == [True, False, False])
        check(s, 'remarks not leaked', last3[1]['remarks'] == 'pipe B remark' and 'pipe A' not in last3[2]['remarks'])
        check(s, 'depths contiguous',
              abs(last3[0]['endDepth'] - last3[1]['startDepth']) < 0.01 and
              abs(last3[1]['endDepth'] - last3[2]['startDepth']) < 0.01)
        check(s, 'borehole depth == deepest pipe',
              abs(bh_of('bh-2026-04')['currentDepth'] - last3[2]['endDepth']) < 0.01,
              f"{bh_of('bh-2026-04')['currentDepth']} vs {last3[2]['endDepth']}")
        check(s, 'new pipes queued for sync', all(r['synced'] is False for r in last3))

        # ---------------------------------------------------------------- pipe log
        s = section('4. Pipe log view')
        goto_tab('Pipe Log')
        rows = lambda: page.locator('tbody tr:not(:has(td[colspan]))').count()
        before_rows = rows()
        check(s, 'lists all pipes', before_rows >= 22, str(before_rows))
        page.fill('input[placeholder*="Search pipe"]', '21')
        page.wait_for_timeout(400)
        check(s, 'search narrows list', rows() < before_rows, f'{before_rows} -> {rows()}')
        page.fill('input[placeholder*="Search pipe"]', '')
        page.wait_for_timeout(300)
        page.click('button:has-text("Water Strikes")')
        page.wait_for_timeout(400)
        strikes = len([r for r in pipes() if r['waterStrike']])
        check(s, 'water-strike filter', rows() == strikes, f'shown={rows()} expected={strikes}')
        page.click('button:has-text("Water Strikes")')
        page.wait_for_timeout(300)

        # delete a single pipe -> only that one goes
        target = pipes()[-1]
        ids_before = {r['id'] for r in pipes()}
        page.locator('button:has(svg.lucide-trash2), button:has-text("Delete")').last.click()
        page.wait_for_timeout(600)
        ids_after = {r['id'] for r in pipes()}
        check(s, 'delete removes exactly one pipe', len(ids_before - ids_after) == 1,
              f'removed {len(ids_before - ids_after)}')

        # ---------------------------------------------------------------- events
        s = section('5. NPT / events')
        goto_tab('Rig Control')
        ev_base = len(events())
        for label in ['BREAKDOWN', 'BIT CHANGE', 'REFUELING', 'WATER STRIKE']:
            page.locator(f'button:has-text("{label}")').first.click()
            page.wait_for_timeout(450)
            page.locator('button:has-text("SAVE")').last.click()
            page.wait_for_timeout(500)
        evs = events()
        check(s, 'four events appended', len(evs) == ev_base + 4, f'{ev_base} -> {len(evs)}')
        check(s, 'event ids unique', len({e['id'] for e in evs}) == len(evs))
        types = [e['type'] for e in evs[:4]]
        check(s, 'all four types stored', set(types) == {'Breakdown', 'Bit Change', 'Refueling', 'Water Strike'}, str(types))
        refuel = next(e for e in evs if e['type'] == 'Refueling')
        check(s, 'refuel captured fuel litres', refuel['details'].get('fuelLiters'), str(refuel['details'].get('fuelLiters')))
        bitchg = next(e for e in evs if e['type'] == 'Bit Change')
        check(s, 'bit change captured new bit', bitchg['details'].get('newBitType'), str(bitchg['details'].get('newBitType')))
        check(s, 'NPT flags set', next(e for e in evs if e['type'] == 'Breakdown')['isNPT'] is True)
        check(s, 'water strike not NPT', next(e for e in evs if e['type'] == 'Water Strike')['isNPT'] is False)

        # the event modal stays mounted between opens - notes must not leak forward
        page.locator('button:has-text("BREAKDOWN")').first.click()
        page.wait_for_timeout(450)
        page.fill('textarea[placeholder="Enter additional details..."]', 'leak canary')
        page.locator('button:has-text("SAVE")').last.click()
        page.wait_for_timeout(500)
        page.locator('button:has-text("BREAKDOWN")').first.click()
        page.wait_for_timeout(450)
        carried = page.locator('textarea[placeholder="Enter additional details..."]').input_value()
        page.locator('button:has-text("SAVE")').last.click()
        page.wait_for_timeout(500)
        latest = events()[0]
        check(s, 'event notes do not leak to the next event',
              carried == '' and latest['details'].get('notes') != 'leak canary',
              f'field={carried!r} saved={latest["details"].get("notes")!r}')

        goto_tab('NPT / Events')
        page.get_by_role('button', name='Breakdown', exact=True).click()
        page.wait_for_timeout(400)
        breakdowns = len([e for e in events() if e['type'] == 'Breakdown'])
        check(s, 'type filter shows only breakdowns',
              page.locator('text=/Hydraulic \\/ Rig Breakdown|Hydraulic Hose Replacement/').count() >= 1
              and page.locator('text=Rig Diesel Refueling').count() == 0,
              f'breakdowns={breakdowns}')
        page.get_by_role('button', name=re.compile(r'^All \(\d+\)$')).click()
        page.wait_for_timeout(300)
        ev_ids_before = {e['id'] for e in events()}
        page.locator('button:has(svg.lucide-trash2)').last.click()
        page.wait_for_timeout(600)
        check(s, 'delete removes exactly one event',
              len(ev_ids_before - {e['id'] for e in events()}) == 1)

        # ---------------------------------------------------------------- analytics
        s = section('6. Analytics')
        goto_tab('Analytics')
        body = page.locator('main').inner_text()
        check(s, 'no NaN on screen', 'NaN' not in body)
        check(s, 'no undefined on screen', 'undefined' not in body)
        check(s, 'charts rendered', page.locator('svg.recharts-surface').count() >= 3,
              str(page.locator('svg.recharts-surface').count()))
        page.screenshot(path='/tmp/e2e_analytics.png', full_page=True)

        # ---------------------------------------------------------------- reports
        s = section('7. Reports export')
        goto_tab('Rig Control')
        try:
            with page.expect_download(timeout=15000) as dl:
                page.click('button:has-text("GENERATE SHIFT REPORT")')
            pdf = dl.value
            check(s, 'PDF report downloads', pdf.suggested_filename.endswith('.pdf'), pdf.suggested_filename)
        except Exception as e:
            check(s, 'PDF report downloads', False, str(e)[:80])
        try:
            with page.expect_download(timeout=15000) as dl:
                page.click('button:has-text("EXPORT BOREHOLE LOG")')
            xls = dl.value
            check(s, 'Excel report downloads', xls.suggested_filename.endswith(('.xlsx', '.xls')), xls.suggested_filename)
        except Exception as e:
            check(s, 'Excel report downloads', False, str(e)[:80])

        # ---------------------------------------------------------------- sync
        s = section('8. Offline sync')
        pending = len([r for r in (ls('wwdm_pipe_records') or []) if not r['synced']]) + \
                  len([e for e in (ls('wwdm_events') or []) if not e['synced']])
        check(s, 'pending badge matches unsynced count',
              str(pending) in page.locator('button[title*="offline changes"]').inner_text(),
              f'pending={pending}')
        page.click('button[title*="offline changes"]')
        page.wait_for_timeout(900)
        after = len([r for r in (ls('wwdm_pipe_records') or []) if not r['synced']]) + \
                len([e for e in (ls('wwdm_events') or []) if not e['synced']])
        check(s, 'sync clears the queue', after == 0, f'{pending} -> {after}')

        # ---------------------------------------------------------------- settings
        s = section('9. Settings')
        open_settings()
        page.fill('input[type="number"] >> nth=0', '6')
        page.click('button:has-text("SAVE SETTINGS")')
        page.wait_for_timeout(600)
        check(s, 'pipe length persisted to borehole', bh_of('bh-2026-04')['defaultPipeLength'] == 6,
              str(bh_of('bh-2026-04')['defaultPipeLength']))
        goto_tab('Rig Control')
        drill_pipe()
        check(s, 'new pipe uses updated length', pipes()[-1]['pipeLength'] == 6, str(pipes()[-1]['pipeLength']))

        open_settings()
        page.locator('input[type="checkbox"]').nth(2).check()   # sunlight mode
        page.click('button:has-text("SAVE SETTINGS")')
        page.wait_for_timeout(600)
        check(s, 'sunlight mode saved', ls('wwdm_settings')['sunlightMode'] is True)
        check(s, 'sunlight theme applied', 'bg-black' in (page.locator('#root > div').first.get_attribute('class') or ''))
        open_settings()
        page.locator('input[type="checkbox"]').nth(2).uncheck()
        page.click('button:has-text("SAVE SETTINGS")')
        page.wait_for_timeout(600)
        check(s, 'sunlight mode toggles back', ls('wwdm_settings')['sunlightMode'] is False)

        # ---------------------------------------------------------------- users
        s = section('10. User management')
        open_settings()
        page.click('button:has-text("Manage Users")')
        page.wait_for_timeout(500)
        MODAL = 'div.fixed.inset-0.z-\\[70\\]'
        m = page.locator(MODAL)
        names = lambda: m.locator('div.rounded-lg.border.p-2\\.5 > div > div.font-black').all_inner_texts()
        m.locator('input[type="text"]').first.fill('E2E Driller')
        m.locator('select').first.select_option('Supervisor')
        m.locator('button:has-text("Add User")').click()
        page.wait_for_timeout(500)
        check(s, 'user added', 'E2E Driller' in names())
        m.locator('div.rounded-lg.border.p-2\\.5', has_text='E2E Driller').locator('button:has-text("Set Active")').click()
        page.wait_for_timeout(400)
        check(s, 'active user switched', ls('wwdm_current_user_id') is not None and
              next(u['name'] for u in ls('wwdm_users') if u['id'] == ls('wwdm_current_user_id')) == 'E2E Driller')
        goto_tab('Rig Control')
        drill_pipe()
        check(s, 'new pipe logged under active user', pipes()[-1]['operator'] == 'E2E Driller',
              pipes()[-1]['operator'])
        open_settings()
        page.click('button:has-text("Manage Users")')
        page.wait_for_timeout(500)
        m.locator('div.rounded-lg.border.p-2\\.5', has_text='E2E Driller').locator('button:has-text("Delete")').click()
        page.wait_for_timeout(600)
        check(s, 'user deleted', 'E2E Driller' not in names())
        check(s, 'active user fell back', ls('wwdm_current_user_id') in [u['id'] for u in ls('wwdm_users')])
        m.locator('button:has(svg.lucide-x)').first.click()
        page.wait_for_timeout(300)
        page.locator('button:has-text("SAVE SETTINGS"), button:has(svg.lucide-x)').last.click()
        page.wait_for_timeout(400)

        # ---------------------------------------------------------------- new project
        s = section('11. New borehole project')
        goto_tab('Rig Control')
        page.locator('button:has-text("BH-2026-04")').first.click()
        page.wait_for_timeout(400)
        page.click('button:has-text("New Borehole")')
        page.wait_for_timeout(500)
        page.fill('input[placeholder*="BH-2026-08"]', 'BH-E2E-01')
        page.fill('input[placeholder*="Rift Valley"]', 'E2E Project')
        page.locator('button:has-text("CREATE"), button[type="submit"]').last.click()
        page.wait_for_timeout(800)
        new_bh = next((b for b in ls('wwdm_boreholes') if b['name'].startswith('BH-E2E-01')), None)
        check(s, 'borehole created', new_bh is not None)
        check(s, 'new borehole is active', ls('wwdm_active_borehole_id') == (new_bh or {}).get('id'))
        check(s, 'new project starts empty', len(pipes(new_bh['id'])) == 0)
        check(s, 'END PIPE inert on fresh project', page.locator('button:has-text("END PIPE")').is_disabled())
        drill_pipe()
        check(s, 'first pipe numbered 1', pipes(new_bh['id'])[0]['pipeNumber'] == 1,
              str(pipes(new_bh['id'])[0]['pipeNumber']))
        check(s, 'other project untouched', len(pipes('bh-2026-04')) >= 22)

        # timer isolation
        s = section('12. Timer isolation across projects')
        page.click('button:has-text("START PIPE")')
        page.wait_for_timeout(800)
        page.locator('button:has-text("BH-E2E-01")').first.click()
        page.wait_for_timeout(400)
        page.locator('text=BH-2026-04').last.click()
        page.wait_for_timeout(800)
        check(s, 'other project shows no running timer',
              page.locator('button:has-text("END PIPE")').is_disabled())
        page.locator('button:has-text("BH-2026-04")').first.click()
        page.wait_for_timeout(400)
        page.locator('text=BH-E2E-01').last.click()
        page.wait_for_timeout(800)
        check(s, 'returning restores the running timer',
              not page.locator('button:has-text("END PIPE")').is_disabled())
        page.click('button:has-text("END PIPE")')
        page.wait_for_timeout(400)
        page.click('button:has-text("SAVE PIPE RECORD")')
        page.wait_for_timeout(500)
        check(s, 'pipe filed to correct project', len(pipes(new_bh['id'])) == 2, str(len(pipes(new_bh['id']))))

        # ---------------------------------------------------------------- persistence
        s = section('13. Persistence across reload')
        snapshot = (len(pipes('bh-2026-04')), len(events('bh-2026-04')), len(ls('wwdm_boreholes')))
        page.reload()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(800)
        check(s, 'data survives reload',
              (len(pipes('bh-2026-04')), len(events('bh-2026-04')), len(ls('wwdm_boreholes'))) == snapshot,
              str(snapshot))
        check(s, 'active project restored', ls('wwdm_active_borehole_id') == new_bh['id'])

        # ---------------------------------------------------------------- delete project
        s = section('14. Delete project')
        open_settings()
        page.click('button:has-text("Delete Project")')
        page.wait_for_timeout(900)
        check(s, 'project removed', all(b['id'] != new_bh['id'] for b in ls('wwdm_boreholes')))
        check(s, 'its pipes removed', len(pipes(new_bh['id'])) == 0)
        check(s, 'fell back to another project', ls('wwdm_active_borehole_id') != new_bh['id'])
        check(s, 'other project intact', len(pipes('bh-2026-04')) >= 22)

        # ---------------------------------------------------------------- reset
        s = section('15. Reset demo data')
        open_settings()
        page.click('button:has-text("Reset Demo Data")')
        page.wait_for_timeout(900)
        check(s, 'boreholes restored to 2', len(ls('wwdm_boreholes')) == 2, str(len(ls('wwdm_boreholes'))))
        check(s, 'pipes restored to 19', len(pipes('bh-2026-04')) == 19, str(len(pipes('bh-2026-04'))))
        check(s, 'restored pipes all have ids', all(r.get('id') for r in pipes('bh-2026-04')))
        check(s, 'users preserved by reset', len(ls('wwdm_users')) >= 3)
        goto_tab('Rig Control')
        drill_pipe()
        check(s, 'drilling works after reset', len(pipes('bh-2026-04')) == 20, str(len(pipes('bh-2026-04'))))

        # ---------------------------------------------------------------- errors
        s = section('16. Runtime health')
        check(s, 'no uncaught page errors', not runtime_errors, str(runtime_errors[:2]))
        real_console = [e for e in console_errors if 'favicon' not in e.lower()]
        check(s, 'no console errors', not real_console, str(real_console[:2]))
        page.screenshot(path='/tmp/e2e_final.png', full_page=True)

        browser.close()


finally:
    stop_server(server)

print('\n' + '=' * 60)
failed = [(s, l, d) for s, l, ok, d in results if not ok]
print(f'{len(results) - len(failed)}/{len(results)} checks passed')
if failed:
    print('\nFAILURES:')
    for s, l, d in failed:
        print(f'  [{s}] {l}' + (f'  -> {d}' if d else ''))
    sys.exit(1)

print('ALL CHECKS PASSED')
