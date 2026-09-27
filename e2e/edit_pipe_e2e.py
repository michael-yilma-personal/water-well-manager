"""A saved pipe can be corrected on the phone, and remarks are kept as typed."""
import os, sys, tempfile
from playwright.sync_api import sync_playwright
OUT = os.environ.get('E2E_OUT', tempfile.gettempdir())
results = []
def check(n, ok, d=''):
    results.append((n, ok)); print(f'{"PASS" if ok else "FAIL"}  {n}' + (f'   -- {d}' if d else ''))

LAST = "() => { const p = JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]'); return p[p.length-1] }"

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True).new_page()
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://localhost:3000', wait_until='networkidle'); page.wait_for_timeout(2000)
    if 'link this device' in page.inner_text('body').lower():
        page.get_by_role('button', name='Work offline for now').click(); page.wait_for_timeout(2500)

    # --- remarks: kept exactly, and never invented
    page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(1200)
    page.get_by_text('END PIPE', exact=True).click(); page.wait_for_timeout(500)
    check('End Pipe sheet labels the field "Remarks"', page.get_by_text('Remarks', exact=True).count() == 1
          and 'DRILLER NOTES' not in page.inner_text('body').upper())
    page.fill('input[placeholder*="Hard Quartzite"]', 'Lost circulation at 17m, regained')
    page.click('button:has-text("SAVE PIPE RECORD")'); page.wait_for_timeout(600)
    check('remarks saved exactly as typed', page.evaluate(LAST)['remarks'] == 'Lost circulation at 17m, regained',
          page.evaluate(LAST)['remarks'])

    page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(1200)
    page.get_by_text('END PIPE', exact=True).click(); page.wait_for_timeout(500)
    page.click('button:has-text("SAVE PIPE RECORD")'); page.wait_for_timeout(600)
    check('blank remarks stay blank', page.evaluate(LAST)['remarks'] == '', repr(page.evaluate(LAST)['remarks']))
    before = page.evaluate(LAST)

    # --- correct the last pipe from the Pipe Log
    page.locator('nav button, .fixed.bottom-0 button').filter(has_text='Pipe Log').first.click(); page.wait_for_timeout(1200)
    check('a hint says pipes can be tapped', page.get_by_text('Tap a pipe to edit or delete it').count() == 1)
    box = page.get_by_role('button', name=f"Edit pipe {before['pipeNumber']}").bounding_box()
    check('the edit target is on screen at phone width, and big enough for a glove',
          box is not None and box['x'] >= 0 and box['x'] + box['width'] <= 411 and box['height'] >= 44, str(box))
    # Tap the depth cell, not the button: the whole row opens the pipe.
    page.locator('tr', has_text=f"#{before['pipeNumber']}").locator('td').nth(1).click(); page.wait_for_timeout(600)
    check('edit sheet opens for that pipe', f"EDIT PIPE #{before['pipeNumber']}" in page.inner_text('body').upper())
    dlg = page.get_by_role('dialog')
    dlg.locator('select').nth(0).select_option('Fresh Basalt / Dolerite')
    dlg.locator('select').nth(1).select_option(index=2)
    dlg.locator('textarea').fill('Corrected: hard dolerite from 20m')
    dlg.get_by_role('button', name='NO', exact=True).click()
    page.screenshot(path=f'{OUT}/edit-pipe-phone.png')
    dlg.get_by_role('button', name='Save Changes').click(); page.wait_for_timeout(700)

    after = page.evaluate(LAST)
    check('formation corrected', after['formation'] == 'Fresh Basalt / Dolerite', after['formation'])
    check('bit type corrected', after['bitType'] != before['bitType'], f"{before['bitType']} -> {after['bitType']}")
    check('remarks corrected', after['remarks'] == 'Corrected: hard dolerite from 20m')
    check('water strike added, at the bottom of the pipe',
          after['waterStrike'] and after['waterStrikeDetails']['depth'] == after['endDepth'], str(after.get('waterStrikeDetails')))
    check('depth, time and rate untouched', all(after[k] == before[k] for k in
          ['startDepth', 'endDepth', 'startTime', 'endTime', 'durationSeconds', 'penetrationRate', 'operator']))
    check('marked as edited', bool(after.get('editedAt')))
    check('same record, not a new one', after['id'] == before['id'] and
          page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').filter(r => r.id === '%s').length" % before['id']) == 1)
    body = page.inner_text('body')
    check('pipe log shows the correction', 'Corrected: hard dolerite from 20m' in body and 'Edited' in body)

    # --- delete now lives inside the edit sheet
    count = page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').length")
    page.on('dialog', lambda d: d.accept())
    page.get_by_role('button', name=f"Edit pipe {before['pipeNumber']}").click(); page.wait_for_timeout(600)
    page.get_by_role('button', name='Delete this pipe').click(); page.wait_for_timeout(700)
    ids = page.evaluate("() => JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').map(r => r.id)")
    check('deleting from the edit sheet removes that pipe', len(ids) == count - 1 and before['id'] not in ids)
    page.screenshot(path=f'{OUT}/pipelog-phone-after.png')
    check('no JS errors', not errs, str(errs[:2]))
    b.close()
print(f'\n{sum(1 for _, ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _, ok in results) else 1)
