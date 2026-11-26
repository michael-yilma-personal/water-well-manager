"""The organization-aware dashboard in a browser, against the project named by
_target (IMPLEMENTATION_STATUS: P2-4 criteria 1 to 5 and 7).

A person active in two organizations must choose one, gets a switcher, and
sees only the chosen organization's boreholes. An invited person sees the
invitation with Accept, and after accepting can make that organization active.
The next person on the same browser gets their own organization (7); the Crew
button and the correction rights follow the membership's role, not the
profile's (3); a photo is shown from the new path or the legacy one (5); a
deactivated member sees why and no records (1).

Same needs, fixture, tear-down and end-state checks as members_e2e.py.

Run:  python3 e2e/saas/dashboard_orgs_e2e.py    (exit 0 only if every check passes)
"""
import uuid

import members_e2e as m
from members_e2e import check, fx

import _target
import tenant_fixture as tf
from playwright.sync_api import sync_playwright


def seen(page, text, timeout=20000):
    """Whether `text` becomes visible on the page."""
    try:
        page.get_by_text(text).first.wait_for(state='visible', timeout=timeout)
        return True
    except Exception:
        return False


def shown(locator, timeout=20000):
    """Whether `locator` becomes visible."""
    try:
        locator.first.wait_for(state='visible', timeout=timeout)
        return True
    except Exception:
        return False


def sign_in(page, account):
    page.fill('input[type="email"]', account.email)
    page.fill('input[type="password"]', account.secret)
    page.get_by_role('button', name='Sign in').click()


def signed_in(browser, base, account, errors):
    page = browser.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/admin.html', wait_until='networkidle')
    sign_in(page, account)
    return page


def sent(author, table, **fields):
    """One row of `author`, as the field app sends it; the HTTP status."""
    m.made.append(str(uuid.uuid4()))
    return m.rest('POST', '/' + table, author, {'id': m.made[-1], 'created_by': author.id,
                                                'recorded_at': '2026-11-25T08:00:00Z', **fields})[0]


def dashboard():
    F, S = fx.founding, fx.second
    dual, invited = fx['dual'], fx['fd']
    f_well, s_well = f'TISO {fx.run} founding well', f'TISO {fx.run} second well'
    f_id = m.borehole(dual, F, f_well)
    m.borehole(dual, S, s_well)
    # On the founding well: a pipe, and two photographed events whose thumbnails
    # are stored one under <org>/<author>/ and one under the legacy <author>/.
    new, old = (f'{uuid.uuid4()}.jpg' for _ in 'ab')
    paths = [f'{F}/{dual.id}/{new[:-4]}_thumb.jpg', f'{dual.id}/{old[:-4]}_thumb.jpg']
    got = [sent(dual, 'pipe_records', borehole_id=f_id, pipe_number=1)]
    got += [sent(dual, 'drilling_events', borehole_id=f_id, type='General Note', title='photo', photo_path=name)
            for name in (new, old)]
    got += [tf.request('POST', f'/storage/v1/object/{tf.BUCKET}/{path}', token=dual.token, data=b'\xff\xd8\xff\xe0 photo',
                       headers={'Content-Type': 'image/jpeg', 'x-upsert': 'true'})[0] for path in paths]
    check('set-up: a pipe, two photographed events and their two stored photos on the founding well',
          all(200 <= x < 300 for x in got), f'HTTP {got}')
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

        print('\n== the next person on the same browser ==', flush=True)
        page.get_by_role('button', name='Sign out').click()
        sign_in(page, fx['sa'])
        check('after sign-out, a member of the second organization only gets its borehole, unasked,'
              ' and nothing of the organization the first person had active',
              seen(page, s_well) and f_well not in page.inner_text('body')
              and 'Choose an organization.' not in page.inner_text('body'))

        print('\n== the role is the membership\'s, not the profile\'s ==', flush=True)
        crew = lambda page: page.get_by_role('button', name='Crew')  # noqa: E731
        page = signed_in(browser, base, fx['fp'], errors)
        check('profile Administrator, membership Driller: the records list, and no Crew button',
              shown(page.locator('table')) and crew(page).count() == 0)
        page = signed_in(browser, base, fx['fh'], errors)
        check('profile Driller, membership Administrator: the Crew button', shown(crew(page)))
        if seen(page, f_well):
            page.get_by_text(f_well).first.click()
        check('and they may correct a pipe somebody else logged',
              shown(page.get_by_role('button', name='Edit pipe 1', exact=True)))
        photos = page.locator('img[alt="Site photo"]')
        shown(photos.nth(1))
        srcs = sorted(src.split('?')[0].split(f'/{tf.BUCKET}/')[-1] for src in
                      (photos.nth(i).get_attribute('src') for i in range(photos.count())))
        check('both photos are shown: one signed on <org>/<author>/, the other on the legacy <author>/',
              srcs == sorted(paths), m.short(srcs, 300))

        print('\n== a deactivated member ==', flush=True)
        fx.set_membership_status(fx['fs'], F, 'deactivated')
        page = signed_in(browser, base, fx['fs'], errors)
        check('they are told why, with Sign out, and see no record',
              seen(page, 'Your membership has been deactivated')
              and page.get_by_role('button', name='Sign out').count() == 1
              and page.locator('table').count() == 0 and f_well not in page.inner_text('body'))

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
