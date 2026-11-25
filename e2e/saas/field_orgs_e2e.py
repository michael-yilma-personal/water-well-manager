"""The organization-aware field app in a browser, and a stand-in for the
installed build 1.1.7 over plain HTTP, against the project named by _target
(IMPLEMENTATION_STATUS: P2-6 criteria 3, 4 and 5).

  3. one membership: nothing is asked; offline work uploads with its
     organization. (The photo under <org>/<user>/ is e2e/photo_e2e.py: a photo
     cannot be attached offline here, because the dev server loads Capacitor's
     web file store on first use.)
  4. two active memberships: the person must choose, holds and uploads only the
     chosen organization's work, cannot switch while work is unsent, and after
     a switch holds nothing of the first organization
  5. requests shaped as 1.1.7 sends them (an upsert with no org_id, the photo
     under <user>/): unchanged with one membership; with two, a new borehole
     is refused and nothing lands in the second organization

Not repeated here, see tenant_isolation_e2e.py: a plain insert without org_id
(sections 1 and 4) and who may read or write the legacy photo path (section 7).

Same needs, fixture, tear-down and end-state checks as members_e2e.py.

Run:  python3 e2e/saas/field_orgs_e2e.py    (exit 0 only if every check passes)
"""
import uuid

import members_e2e as m
from dashboard_orgs_e2e import seen
from members_e2e import check, fx

import _target
import tenant_fixture as tf
from playwright.sync_api import sync_playwright

HAS_WELL = "(n) => JSON.parse(localStorage.getItem('wwdm_boreholes') || '[]').some(b => b.name === n)"
QUEUED = "() => JSON.parse(localStorage.getItem('wwdm_outbox') || '[]').some(o => o.entity === 'pipeRecord')"
DRAINED = "() => JSON.parse(localStorage.getItem('wwdm_outbox') || '[]').length === 0"


def waited(page, js, arg=None, timeout=60000):
    try:
        page.wait_for_function(js, arg=arg, timeout=timeout)
        return True
    except Exception:
        return False


def stored(page, key):
    return page.evaluate("(k) => JSON.parse(localStorage.getItem(k) || '[]')", key)


def linked(browser, account, errors):
    """A fresh device on which `account` has just pressed "Link this device"."""
    ctx = browser.new_context(viewport={'width': 411, 'height': 900}, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto(_target.start_app(), wait_until='networkidle')
    page.fill('input[type="email"]', account.email)
    page.fill('input[type="password"]', account.secret)
    page.get_by_role('button', name='Link this device').click()
    return ctx, page


def log_offline(ctx, page, well):
    """Open the pulled borehole `well`, go offline and log a pipe. Returns the
    queued operations, still offline."""
    page.evaluate("""(n) => localStorage.setItem('wwdm_active_borehole_id',
        JSON.parse(localStorage.getItem('wwdm_boreholes')).find(b => b.name === n).id)""", well)
    page.reload(wait_until='networkidle')
    page.get_by_text('START PIPE', exact=True).wait_for(state='visible', timeout=30000)
    ctx.set_offline(True)
    page.get_by_text('START PIPE', exact=True).click()
    page.wait_for_timeout(700)
    page.get_by_text('END PIPE', exact=True).click()
    page.get_by_text('SAVE PIPE RECORD').click()
    waited(page, QUEUED)
    return stored(page, 'wwdm_outbox')


def back_online(ctx, page):
    ctx.set_offline(False)
    page.evaluate("() => window.dispatchEvent(new Event('online'))")
    return waited(page, DRAINED)


def field_app():
    F, S = fx.founding, fx.second
    one, two = fx['fd'], fx['dual']
    one_well, f_well, s_well = (f'TISO {fx.run} {x} well' for x in ('own', 'founding', 'second'))
    m.borehole(one, F, one_well)
    m.borehole(two, F, f_well)
    m.borehole(two, S, s_well)
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch()

        print('\n== 3. a person with one membership ==', flush=True)
        ctx, page = linked(browser, one, errors)
        check('linking goes straight to their records: nothing is asked',
              waited(page, HAS_WELL, one_well) and 'Choose an organization.' not in page.inner_text('body'))
        queue = log_offline(ctx, page, one_well)
        check('work entered offline is queued under the founding organization',
              len(queue) >= 2 and all(o.get('orgId') == F for o in queue),
              m.short([(o['entity'], o.get('orgId')) for o in queue]))
        check('and uploads once online', back_online(ctx, page), m.short(stored(page, 'wwdm_outbox'), 300))
        check('the borehole and the pipe are in the founding organization',
              fx.record_counts(one) == {F: 2}, m.short(fx.record_counts(one)))
        ctx.close()

        print('\n== 4. a person active in two organizations ==', flush=True)
        ctx, page = linked(browser, two, errors)
        choice = page.locator('button', has_text=fx.second_name)
        check('they must choose: the organization screen, and no record on the device',
              seen(page, 'Choose an organization.') and choice.count() == 1
              and stored(page, 'wwdm_boreholes') == [] and 'CURRENT DEPTH' not in page.inner_text('body'))
        choice.click()
        check('after choosing the second organization the device holds its borehole and not the founding one',
              waited(page, HAS_WELL, s_well) and not page.evaluate(HAS_WELL, f_well))
        queue = log_offline(ctx, page, s_well)
        check('work entered offline is queued under the chosen organization',
              len(queue) >= 2 and all(o.get('orgId') == S for o in queue),
              m.short([(o['entity'], o.get('orgId')) for o in queue]))
        page.get_by_text(s_well, exact=False).first.click()
        page.get_by_text('Rig Settings', exact=True).click()
        switch = page.get_by_label('Organization')
        check('a switch is refused while work is unsent',
              switch.count() == 1 and switch.is_disabled()
              and 'record(s) still uploading' in page.inner_text('body'))
        check('the work uploads once online', back_online(ctx, page), m.short(stored(page, 'wwdm_outbox'), 300))
        check('and it is all in the chosen organization: nothing new in the founding one',
              fx.record_counts(two) == {F: 1, S: 2}, m.short(fx.record_counts(two)))
        switch.select_option(F)
        check('after switching, the device holds the founding borehole',
              waited(page, HAS_WELL, f_well) and page.evaluate("() => localStorage.getItem('wwdm_active_org')") == F)
        check('and nothing of the second organization',
              not page.evaluate(HAS_WELL, s_well) and stored(page, 'wwdm_pipe_records') == [],
              m.short([b['name'] for b in stored(page, 'wwdm_boreholes')]))
        check('no JS errors', not errors, m.short(errors[:2]))
        browser.close()


def legacy_send(account, table, row):
    """An upsert as build 1.1.7 sends it (main:src/services/syncTransport.ts)."""
    m.made.append(row['id'])
    status, raw = tf.request('POST', f'/rest/v1/{table}?on_conflict=id', token=account.token,
                             body={**row, 'created_by': account.id, 'recorded_at': '2026-11-25T08:00:00Z'},
                             headers={'Prefer': 'resolution=merge-duplicates'})
    return status, tf.parse(raw)


def legacy_client():
    print('\n== 5. the stand-in for build 1.1.7 ==', flush=True)
    F, S = fx.founding, fx.second
    who, well = fx['fv'], str(uuid.uuid4())
    hole = lambda rid: {'id': rid, 'name': f'TISO {fx.run} legacy', 'project': 'legacy', 'status': 'active'}  # noqa: E731
    pipe = lambda n: {'id': str(uuid.uuid4()), 'borehole_id': well, 'pipe_number': n, 'remarks': 'legacy'}  # noqa: E731
    path = f'{who.id}/{uuid.uuid4()}.jpg'
    got = [legacy_send(who, 'boreholes', hole(well))[0], legacy_send(who, 'pipe_records', pipe(1))[0],
           tf.request('POST', f'/storage/v1/object/{tf.BUCKET}/{path}', token=who.token, data=b'\xff\xd8\xff\xe0 legacy',
                      headers={'Content-Type': 'image/jpeg', 'x-upsert': 'true'})[0]]
    check('one membership: a borehole without org_id, a pipe record and a photo on <user>/ are accepted',
          all(200 <= s < 300 for s in got), f'HTTP {got}')
    check('and the records are in the founding organization, the photo where it was sent',
          fx.record_counts(who) == {F: 2} and path in fx.photo_state([path]), m.short(fx.record_counts(who)))

    invited = m.fn('POST', fx['sa'], S, email=who.email, name='x', role='Driller')[0]
    accepted = m.rest('POST', '/rpc/accept_membership', who, {'org': S})[0]
    check('set-up: the person accepts an invitation and is active in two organizations',
          invited == 201 and m.memberships(who.id) == sorted([(F, 'Driller', 'active'), (S, 'Driller', 'active')]),
          f'HTTP {invited}, {accepted}')
    refused = str(uuid.uuid4())
    status, body = legacy_send(who, 'boreholes', hole(refused))
    check('two memberships: a new borehole without org_id is refused (42501) and not stored',
          status == 403 and isinstance(body, dict) and body.get('code') == '42501'
          and not fx.record_state([refused]), f'HTTP {status} {m.short(body)}')
    status, body = legacy_send(who, 'pipe_records', pipe(2))
    check('a pipe on their existing borehole still uploads, and nothing is in the second organization',
          200 <= status < 300 and fx.record_counts(who) == {F: 3},
          f'HTTP {status} {m.short(body)} {m.short(fx.record_counts(who))}')


def checks():
    legacy_client()
    field_app()


if __name__ == '__main__':
    m.run(checks)
