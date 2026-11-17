"""A browser too old for the bundle must see a message, not a blank page.

Drives the built output (vite preview), because the gate is an inline classic
script in index.html and admin.html that the build must leave untouched. An
old browser is simulated by denying the CSS feature the gate checks; the real
iOS 12 case (a parse error on the bundle) cannot be reproduced in Chromium,
but it takes the same branch of the same script, which the unit test covers.

Run with:  npm run test:unsupported   (builds first)
"""
import os
import signal
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('E2E_PREVIEW_PORT', '4173'))
URL = f'http://localhost:{PORT}'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ['/index.html', '/admin.html']
DENY_CSS = 'CSS.supports = function () { return false; };'


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(('127.0.0.1', port)) == 0


def start_preview():
    subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proc = subprocess.Popen(
        ['npx', 'vite', 'preview', '--host', '127.0.0.1', '--port', str(PORT), '--strictPort'],
        cwd=ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(60):
        if port_open(PORT):
            return proc
        if proc.poll() is not None:
            sys.exit('vite preview exited before becoming ready')
        time.sleep(0.5)
    stop(proc)
    sys.exit(f'vite preview did not come up on {PORT}')


def stop(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


STATE = """
() => ({
  root: !!document.getElementById('root'),
  rootChildren: (document.getElementById('root') || {}).childElementCount || 0,
  gate: !!document.getElementById('unsupported-browser'),
  text: document.body.innerText,
})
"""

failures = []


def check(cond, label):
    print(('  ok   ' if cond else '  FAIL ') + label)
    if not cond:
        failures.append(label)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for path in PAGES:
            print(f'\n== {path}: browser without the required CSS support')
            ctx = browser.new_context()
            ctx.add_init_script(DENY_CSS)
            page = ctx.new_page()
            page.goto(URL + path, wait_until='networkidle')
            page.wait_for_timeout(1500)
            s = page.evaluate(STATE)
            check(s['gate'], 'message element is on the page')
            check('too old' in s['text'], 'message says the software is too old')
            check('iOS 16 or newer' in s['text'], 'message names the version needed')
            check(not s['root'], 'app mount point was taken over, so React did not render')
            ctx.close()

            print(f'== {path}: current browser')
            ctx = browser.new_context()
            page = ctx.new_page()
            page.goto(URL + path, wait_until='networkidle')
            page.wait_for_timeout(2500)
            s = page.evaluate(STATE)
            check(not s['gate'], 'no message shown')
            check(s['root'] and s['rootChildren'] > 0, 'app mounted into #root')
            ctx.close()
        browser.close()


proc = start_preview()
try:
    run()
finally:
    stop(proc)

print(f"\n{'PASS' if not failures else 'FAIL'} - {len(failures)} failed check(s)")
sys.exit(0 if not failures else 1)
