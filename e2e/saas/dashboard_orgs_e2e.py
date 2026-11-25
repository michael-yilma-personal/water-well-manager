"""The organization-aware dashboard in a browser, against the project named by
_target (IMPLEMENTATION_STATUS: P2-4 criteria 1, 2 and 4).

A person active in two organizations must choose one, gets a switcher, and
sees only the chosen organization's boreholes. An invited person sees the
invitation with Accept, and after accepting can make that organization active.

Same needs, fixture, tear-down and end-state checks as members_e2e.py.

Run:  python3 e2e/saas/dashboard_orgs_e2e.py    (exit 0 only if every check passes)
"""
import members_e2e as m
from members_e2e import check, fx

import _target
from playwright.sync_api import sync_playwright


def seen(page, text, timeout=20000):
    """Whether `text` becomes visible on the page."""
    try:
        page.get_by_text(text).first.wait_for(state='visible', timeout=timeout)
        return True
    except Exception:
        return False


def signed_in(browser, base, account, errors):
    page = browser.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/admin.html', wait_until='networkidle')
    page.fill('input[type="email"]', account.email)
    page.fill('input[type="password"]', account.secret)
    page.get_by_role('button', name='Sign in').click()
    return page


def dashboard():
    F, S = fx.founding, fx.second
    dual, invited = fx['dual'], fx['fd']
    f_well, s_well = f'TISO {fx.run} founding well', f'TISO {fx.run} second well'
    m.borehole(dual, F, f_well)
    m.borehole(dual, S, s_well)
    status, body = m.fn('POST', fx['sa'], S, email=invited.email, name='x', role='Supervisor')
    check('set-up: a founding member is invited to the second organization',
          status == 201 and body.get('outcome') == 'invited', f'HTTP {status} {m.short(body)}')
    switcher = lambda page: page.get_by_label('Organization')  # noqa: E731
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        base = _target.start_app()

        print('\n== a person active in two organizations ==', flush=True)
        page = signed_in(browser, base, dual, errors)
        check('with nothing remembered they are asked to choose an organization',
              seen(page, 'Choose an organization.') and page.locator('button', has_text=fx.second_name).count() == 1)
        body = page.inner_text('body')
        check('no record of either organization is shown before they choose',
              f_well not in body and s_well not in body and switcher(page).count() == 0)
        page.locator('button', has_text=fx.second_name).click()
        check('after choosing the second organization they see its borehole', seen(page, s_well))
        check('and not the founding organization\'s borehole', f_well not in page.inner_text('body'))
        check('the header has the switcher (aria-label "Organization")', switcher(page).count() == 1)
        if switcher(page).count() == 1:
            switcher(page).select_option(F)
        check('after switching to the founding organization they see its borehole', seen(page, f_well))
        check('and no longer the second organization\'s borehole', s_well not in page.inner_text('body'))
        page.screenshot(path=f'{_target.OUT}/dashboard-orgs-switched.png')

        print('\n== an invited person ==', flush=True)
        page = signed_in(browser, base, invited, errors)
        check('the invitation notice names the organization',
              seen(page, f'You have been invited to join {fx.second_name}'))
        accept = page.get_by_role('button', name='Accept')
        check('with Accept and Decline, and no switcher while one organization is active',
              accept.count() == 1 and page.get_by_role('button', name='Decline').count() == 1
              and switcher(page).count() == 0)
        check('the invitation shows none of that organization\'s records', s_well not in page.inner_text('body'))
        page.screenshot(path=f'{_target.OUT}/dashboard-orgs-invited.png')
        if accept.count() == 1:
            accept.click()
        try:
            switcher(page).wait_for(state='visible', timeout=20000)
            switcher(page).select_option(S)
        except Exception:
            pass
        check('after Accept the organization can be made active and its borehole is shown', seen(page, s_well))
        got = m.memberships(invited.id)
        check('and the membership is active in the database',
              got == sorted([(F, 'Driller', 'active'), (S, 'Supervisor', 'active')]), m.short(got))
        check('no JS errors', not errors, m.short(errors[:2]))
        browser.close()


if __name__ == '__main__':
    m.run(dashboard)
