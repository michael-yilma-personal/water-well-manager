"""Cancelling a pipe must lose no time and add no fake depth."""
import sys
from playwright.sync_api import sync_playwright
OUT='/private/tmp/claude-501/-Users-kalena-dev-water-well-drilling-manager/4c525f0f-604d-4e86-8f8e-b68bbddc1172/scratchpad'
results=[]
def check(n, ok, d=''):
    results.append((n,ok)); print(f'{"PASS" if ok else "FAIL"}  {n}'+(f'   -- {d}' if d else ''))
STATE = """() => ({
  depth: (document.body.innerText.match(/CURRENT DEPTH\\s*\\n\\s*([\\d.]+)/)||[])[1],
  pipes: JSON.parse(localStorage.getItem('wwdm_pipe_records')||'[]').length,
  events: JSON.parse(localStorage.getItem('wwdm_events')||'[]').length,
  timer: localStorage.getItem('wwdm_active_timer'),
  inProgress: document.body.innerText.includes('IN PROGRESS'),
})"""
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':411,'height':900}, is_mobile=True)
    page=ctx.new_page(); errs=[]
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto('http://localhost:3000', wait_until='networkidle'); page.wait_for_timeout(2000)
    if 'link this device' in page.inner_text('body').lower():
        page.get_by_role('button', name='Work offline for now').click(); page.wait_for_timeout(2500)
    before = page.evaluate(STATE)
    check('rig UI is up', before['depth'] is not None, str(before)[:80])

    page.get_by_text('START PIPE', exact=True).click(); page.wait_for_timeout(1500)
    running = page.evaluate(STATE)
    check('pipe is running', running['inProgress'])
    check('Cancel Pipe is offered', page.get_by_text('Cancel Pipe').count() > 0)

    page.get_by_text('Cancel Pipe').first.click(); page.wait_for_timeout(2500)
    after = page.evaluate(STATE)

    check('timer stops', not after['inProgress'], f"inProgress={after['inProgress']}")
    check('no fake pipe record is written', after['pipes'] == before['pipes'],
          f"{before['pipes']} -> {after['pipes']}")
    check('depth is unchanged', after['depth'] == before['depth'],
          f"{before['depth']} -> {after['depth']}")
    check('the lost time is logged as an event', after['events'] == before['events'] + 1,
          f"{before['events']} -> {after['events']}")

    logged = page.evaluate("""() => {
      const e = JSON.parse(localStorage.getItem('wwdm_events')||'[]');
      const c = e.find(x => (x.title||'').includes('cancelled'));
      return c ? {title: c.title, isNPT: c.isNPT, mins: c.durationMinutes} : null;
    }""")
    check('it is recorded as downtime with a duration',
          bool(logged) and logged['isNPT'] and logged['mins'] >= 1, str(logged))

    page.locator('nav button, .fixed.bottom-0 button').filter(has_text='Downtime').first.click()
    page.wait_for_timeout(1800)
    check('it appears in the Downtime view', 'cancelled' in page.inner_text('body').lower(),
          page.inner_text('body')[:70].replace('\n',' | '))
    page.screenshot(path=f'{OUT}/cancel-pipe.png')

    check('START PIPE is available again', page.get_by_text('Rig Control').count() > 0)
    check('no JS errors', not errs, str(errs[:2]))
    b.close()
print(f'\n{sum(1 for _,ok in results if ok)}/{len(results)} passed')
sys.exit(0 if all(ok for _,ok in results) else 1)
