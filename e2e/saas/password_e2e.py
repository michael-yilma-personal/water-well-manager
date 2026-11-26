"""Changing and resetting a password (SaaS Phase 5, P5-1 and P5-2; D5-1 to D5-3)
with real sign-ins, real HTTP and a browser, against the project named by _target.

  A. change the password in the field app (Rig Settings), the dashboard and the
     console: a wrong current one changes nothing; the new one works, the old
     one does not, and the person stays signed in in that browser
  B. the account's other sessions end: their refresh token no longer refreshes
     (D5-1 as changed 2026-11-26); a field device's queued work is kept and
     uploads after signing in with the new password
  C. "Forgot password?" on each sign-in screen: the same sentence for an
     unknown and a known address; an empty address sends nothing
  D. the recovery link (from the Auth admin API, D5-3) sets the password on
     admin.html, leaves nothing stored, and a used link says so

Only fixture accounts change password; the kept accounts are never touched
(the end-state fingerprint covers every account's credential).

Same needs, fixture, tear-down and end-state checks as members_e2e.py.

Run:  python3 e2e/saas/password_e2e.py    (exit 0 only if every check passes)
"""
import base64
import json
import re
import time
import uuid
from urllib.parse import urlparse

import field_orgs_e2e as f
import members_e2e as m
from dashboard_orgs_e2e import seen, signed_in
from members_e2e import check, fx
from platform_e2e import console

import _target
import tenant_fixture as tf
from playwright.sync_api import sync_playwright

WRONG = 'The current password is not correct.'
CHANGED = 'Your password has been changed.'
SENT = 'If an account uses this address, an email with a link to set a new password is on its way.'
NOTE = 'Other devices signed in to this account will ask to sign in again.'
RECOVERED = 'Your password is set. Sign in again in the app you use.'
USED = 'This link is invalid or has expired.'
STORED = "() => Object.values(localStorage).filter(v => /access_token|refresh_token/.test(v || ''))"


def works(email, secret):
    return tf.sign_in(email, secret)[0] is not None


def fresh():
    return uuid.uuid4().hex + 'Aa1'


def expires_in(access):
    claims = json.loads(base64.urlsafe_b64decode(access.split('.')[1] + '=='))
    return int(claims['exp'] - time.time())


def change(page, current, new):
    page.get_by_label('Current password', exact=True).fill(current)
    page.get_by_label('New password', exact=True).fill(new)
    page.get_by_label('New password again', exact=True).fill(new)
    page.get_by_role('button', name='Change password', exact=True).click()


def change_in(app, page, who, home, other=None):
    """Part A in one app; with `other` (a second session's tokens), part B."""
    old, new = who.secret, fresh()
    check(f'{app}: the form says other devices will ask to sign in again', seen(page, NOTE))
    change(page, fresh(), new)
    check(f'{app}: a wrong current password gives the sentence and the old password still signs in',
          seen(page, WRONG) and works(who.email, old))
    change(page, old, new)
    done = seen(page, CHANGED)
    check(f'{app}: after the change the new password signs in over HTTP and the old one does not',
          done and works(who.email, new) and not works(who.email, old))
    who.secret = new
    if other:
        access, refresh = other
        user = tf.request('GET', '/auth/v1/user', token=access)
        rest = tf.request('GET', '/rest/v1/boreholes?select=id&limit=1', token=access)[0]
        got = tf.request('POST', '/auth/v1/token?grant_type=refresh_token', body={'refresh_token': refresh})
        check('B: another session\'s refresh token no longer refreshes after the change (D5-1 as changed)',
              got[0] != 200, f'refresh HTTP {got[0]} {m.short(tf.parse(got[1]))}; its access token:'
              f' /auth/v1/user HTTP {user[0]} {m.short(tf.parse(user[1]), 90)}, /rest/v1 HTTP {rest},'
              f' expires in {expires_in(access)} s')
    page.reload(wait_until='networkidle')
    tokens = [t for v in page.evaluate(STORED) for t in re.findall(r'"access_token":"([^"]+)"', v)]
    check(f'{app}: the person is still signed in in that browser',
          seen(page, home) and any(tf.request('GET', '/auth/v1/user', token=t)[0] == 200 for t in tokens),
          f'{len(tokens)} stored token(s)')


def forgot(app, page, known):
    asked = []
    page.on('request', lambda r: '/auth/v1/recover' in r.url and asked.append(r.url))
    page.get_by_role('button', name='Forgot password?').click()
    send = page.get_by_role('button', name='Send reset link')
    send.click()
    check(f'C {app}: an empty address is refused without a request', seen(page, 'Enter your email address.') and not asked)
    said = []
    for email in (fx.email('nobody-' + app.replace(' ', '-')), known.email):
        page.locator('input[aria-label="Email"]').last.fill(email)
        with page.expect_response(lambda r: '/auth/v1/recover' in r.url) as answer:
            send.click()
        page.wait_for_function('() => !document.body.innerText.includes("Please wait")')
        body = page.inner_text('body')
        said.append((answer.value.status, m.short(answer.value.text(), 70), SENT in body))
    check(f'C {app}: an unknown and a known address get the same sentence, whatever the server answered',
          all(x[2] for x in said), m.short(said, 400))


def checks():
    F, errors = fx.founding, []
    pa = fx._create_account('pa')
    fx.remove_membership(pa, F)   # RF-160
    tf.sql(f'insert into public.platform_admins (user_id) values ({tf.uid(pa.id)});')
    well = f'TISO {fx.run} password well'
    m.borehole(fx['fd'], F, well)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            base = _target.start_app()

            print('\n== A. change the password in each app; B. another session ==', flush=True)
            ctx, page = f.linked(browser, fx['fd'], errors)
            f.waited(page, f.HAS_WELL, well)
            page.get_by_text(well, exact=False).first.click()
            page.get_by_text('Rig Settings', exact=True).click()
            change_in('field app', page, fx['fd'], well)
            fd, new = fx['fd'], fresh()
            f.log_offline(ctx, page, well)
            token = tf.sign_in(fd.email, fd.secret)[0]
            status = tf.request('PUT', '/auth/v1/user', token=token, body={'password': new})[0]
            fd.secret = new
            # The device's access token outlives its ended session; expire it, as the clock would.
            page.evaluate("""() => Object.keys(localStorage).filter(k => /^sb-.*-auth-token$/.test(k)).forEach(k =>
                localStorage.setItem(k, JSON.stringify({...JSON.parse(localStorage.getItem(k)), expires_at: 0})))""")
            ctx.set_offline(False)
            page.reload(wait_until='networkidle')
            asked = seen(page, 'Link this device') and page.evaluate(f.QUEUED)
            page.fill('input[type="email"]', fd.email)
            page.fill('input[type="password"]', fd.secret)
            page.get_by_role('button', name='Link this device').click()
            check('B: a device whose session ended by a password change elsewhere asks to sign in, keeps its unsent'
                  ' pipe, and uploads it after signing in with the new password',
                  status == 200 and asked and f.waited(page, f.DRAINED) and fx.record_counts(fd) == {F: 2},
                  f'PUT /auth/v1/user HTTP {status}; asked {asked}; {m.short(fx.record_counts(fd))}')
            ctx.close()

            who = fx['fs']
            status, raw = tf.request('POST', '/auth/v1/token?grant_type=password',
                                     body={'email': who.email, 'password': who.secret})
            body = tf.parse(raw)
            check('B set-up: a second, independent session of the dashboard account', status == 200, f'HTTP {status}')
            page = signed_in(browser, base, who, errors)
            page.get_by_role('button', name='Password', exact=True).click()
            change_in('dashboard', page, who, 'Sign out', (body.get('access_token'), body.get('refresh_token')))

            page = console(browser, pa, errors)
            page.get_by_role('button', name='Password', exact=True).click()
            change_in('console', page, pa, 'Sign out')

            print('\n== C. Forgot password ==', flush=True)
            for app, path, known in (('field app', '/', fx['sd']), ('dashboard', '/admin.html', fx['ss']),
                                     ('console', '/platform.html', fx['sx'])):
                page = browser.new_context().new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base + path, wait_until='networkidle')
                forgot(app, page, known)

            print('\n== D. the recovery link ==', flush=True)
            who, new = fx['fp'], fresh()
            status, body = tf._service('POST', '/auth/v1/admin/generate_link', body={
                'type': 'recovery', 'email': who.email,
                'redirect_to': base.replace('127.0.0.1', 'localhost') + '/admin.html'})
            link = isinstance(body, dict) and (body.get('action_link') or (body.get('properties') or {}).get('action_link'))
            check('D set-up: the Auth admin API gives a recovery link', status == 200 and link, f'HTTP {status}')
            page = browser.new_context().new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(link, wait_until='networkidle')
            check('D: the link opens the new-password form on admin.html',
                  urlparse(page.url).path == '/admin.html' and seen(page, 'Set a new password')
                  and page.get_by_label('New password again', exact=True).count() == 1, m.short(urlparse(page.url).path))
            page.get_by_label('New password', exact=True).fill(new)
            page.get_by_label('New password again', exact=True).fill(new)
            page.get_by_role('button', name='Set password').click()
            check('D: the password is set (the new one signs in over HTTP, the old one does not) and the page says'
                  ' to sign in again', seen(page, RECOVERED) and works(who.email, new) and not works(who.email, who.secret))
            check('D: nothing is stored and the address no longer carries the tokens',
                  page.evaluate(STORED) == [] and not re.search(r'access_token|refresh_token', page.url),
                  m.short(page.url.split('#')[-1][:40]))
            who.secret = new
            page.goto(link, wait_until='networkidle')
            check('D: an already-used link shows its sentence', seen(page, USED))
            check('no JS errors', not errors, m.short(errors[:2]))
            browser.close()
    finally:
        tf.sql(f'delete from public.platform_admins where user_id = {tf.uid(pa.id)};')


if __name__ == '__main__':
    m.run(checks)
