"""Shared helper: attach Playwright to the running APK's WebView over CDP.

Device suites (apk_sync_e2e.py, apk_photo_e2e.py) are different from the
browser suites in one way that matters: the app on the device has its project
compiled in, so the suite cannot point it anywhere. The suite's own API calls
go to the project named by _target; the build on the device must have been
made for that same project, or the two halves of the test would talk to
different databases - and a store build talks to production.

So these suites refuse to run (one line, exit 2) unless

    DRILL_E2E_APK_TARGET_REF=<project ref the installed build was made for>

is set and equals the project ref of DRILL_E2E_SUPABASE_URL. _target has
already refused production, so a production build can never match. To make a
matching build: `npm run build` with VITE_SUPABASE_URL and
VITE_SUPABASE_PUBLISHABLE_KEY set to the target, `npx cap sync android`,
build and install the APK.

The variable is the operator's declaration. As a second line of defence,
apk_page() reads the scripts the WebView actually loaded and refuses if any of
them names the production project.
"""
import _target

_target.require_device_build()

from playwright.sync_api import sync_playwright
import contextlib

OUT = _target.OUT

# Every script the page has loaded, concatenated. Runs inside the WebView, so
# it only re-reads the app's own bundled files.
_LOADED_SCRIPTS = """async () => {
  const urls = new Set();
  for (const s of document.scripts) if (s.src) urls.add(s.src);
  for (const e of performance.getEntriesByType('resource'))
    if (/\\.m?js(\\?|$)/.test(e.name)) urls.add(e.name);
  let text = '';
  for (const s of document.scripts) if (!s.src) text += s.textContent + '\\n';
  for (const u of urls) {
    try { text += await (await fetch(u)).text() + '\\n'; } catch (e) {}
  }
  return text;
}"""


@contextlib.contextmanager
def apk_page():
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp('http://localhost:9222')
        ctx = browser.contexts[0]
        page = ctx.pages[0]
        problem = _target.production_source_problem(
            page.evaluate(_LOADED_SCRIPTS), 'the build installed on the device')
        if problem:
            _target.refuse(problem)
        logs = []
        page.on('console', lambda m: logs.append(f'[{m.type}] {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'[pageerror] {e}'))
        yield page, logs
