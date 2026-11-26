"""The platform console and audit (SaaS Phase 4) with real sign-ins, against the
project named by _target: the three phase acceptance points and D4-1.

  A. a new company is onboarded from the console with no SQL: organization and
     first Administrator; that Administrator adds a Driller through Crew; the
     Driller's borehole reaches the server in that organization
  B. every administrative action is in the audit log with actor, time and
     details, and in the console's audit list
  C. non-platform accounts cannot open or call any of it (and D4-6)
  D. the platform administrator reads no Drill record (D4-1)

The platform administrator is a fixture account added to platform_admins
through the database and removed afterwards (D4-2).

Same needs, fixture, tear-down and end-state checks as members_e2e.py.

Run:  python3 e2e/saas/platform_e2e.py    (exit 0 only if every check passes)
"""
import uuid

import field_orgs_e2e as f
import members_e2e as m
from dashboard_orgs_e2e import seen, signed_in
from members_e2e import check, fx

import _target
import tenant_fixture as tf
from playwright.sync_api import sync_playwright

FUNCTIONS = {'platform_create_organization': lambda o: {'p_name': f'TISO {fx.run} refused', 'p_plan': 'standard',
                                                        'p_status': 'trial'},
             'platform_update_subscription': lambda o: {'p_org': o, 'p_action': 'suspend', 'p_args': {}},
             'platform_organizations': lambda o: {},
             'platform_members': lambda o: {'p_org': o}}
REFUSAL = 'This account is not a platform administrator.'


def console(browser, account, errors):
    page = browser.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(_target.start_app() + '/platform.html', wait_until='networkidle')
    page.fill('input[placeholder="Email"]', account.email)
    page.fill('input[placeholder="Password"]', account.secret)
    page.get_by_role('button', name='Sign in').click()
    return page


def rpc(name, account, org):
    status, raw = tf.request('POST', f'/rest/v1/rpc/{name}', token=account and account.token, body=FUNCTIONS[name](org))
    body = tf.parse(raw)
    return status, body.get('code') if isinstance(body, dict) else None


def checks():
    t0 = tf.query('select now()::text as started')[0]['started']
    pa = fx._create_account('pa')
    fx.remove_membership(pa, fx.founding)   # RF-160: the Auth admin API mirrors it into the founding organization
    tf.sql(f'insert into public.platform_admins (user_id) values ({tf.uid(pa.id)});')
    org, name, errors, asked = None, f'TISO {fx.run} onboarded', [], []
    try:
        check('set-up: a platform administrator with no membership', pa.sign_in() and m.memberships(pa.id) == [])
        with sync_playwright() as p:
            browser = p.chromium.launch()
            print('\n== A. onboarding from the console ==', flush=True)
            page = console(browser, pa, errors)
            page.on('dialog', lambda d: (asked.append(d.message), d.accept()))
            # Until the plans load, the required Plan select is empty and the browser blocks the submit.
            page.get_by_label('Plan').locator('option').first.wait_for(state='attached')
            page.get_by_label('Name', exact=True).fill(name)
            page.get_by_label('Starts as').select_option('trial')
            page.get_by_label('End date (optional)').fill('2027-01-31')
            oa = fx.add_account('oa', fx.email('oa'), None, uuid.uuid4().hex + 'Aa1')
            page.get_by_label("First administrator's email").fill(oa.email)
            page.get_by_label('Their name').fill(f'TISO oa {fx.run}')
            page.get_by_label('Temporary password').fill(oa.secret)
            page.get_by_role('button', name='Create', exact=True).click()
            seen(page, f'{name} was created. {oa.email} is its administrator')
            rows = tf.query(f"select o.id, s.status, s.ends_at::text as ends from public.organizations o join"
                            f" public.subscriptions s on s.org_id = o.id where o.name = {tf.text_lit(name)}")
            org = rows[0]['id'] if len(rows) == 1 else None
            oa.id = fx.account_by_email(oa.email)
            check('the console creates the organization (trial, end date) and its first Administrator, a member'
                  ' of it only', org and rows[0]['status'] == 'trial' and rows[0]['ends'].startswith('2027-01-31 23:59:59')
                  and oa.id and m.memberships(oa.id) == [(org, 'Administrator', 'active')], m.short(rows))

            od = fx.add_account('od', fx.email('od'), None, uuid.uuid4().hex + 'Aa1')
            dash = signed_in(browser, _target.start_app(), oa, errors)
            dash.get_by_role('button', name='Crew').click()
            dash.get_by_role('button', name='Add crew member').click()
            dash.fill('input[type="email"]', od.email)
            dash.fill('input[placeholder="at least 8 characters"]', od.secret)
            dash.fill('input[placeholder="Joe Kamau"]', f'TISO od {fx.run}')
            dash.get_by_role('button', name='Create account').click()
            seen(dash, od.email)
            od.id = fx.account_by_email(od.email)
            check('its Administrator signs in to the dashboard and adds a Driller through Crew, a member of it only',
                  od.id and m.memberships(od.id) == [(org, 'Driller', 'active')], m.short(od.id and m.memberships(od.id)))

            well = f'TISO {fx.run} onboarded well'
            ctx, field = f.linked(browser, od, errors)
            field.get_by_role('button', name='Create a borehole').click()
            field.fill('input[placeholder*="BH-2026-08"]', well)
            field.fill('input[placeholder*="Rift Valley"]', 'platform e2e')
            field.get_by_text('CREATE BOREHOLE SITE').click()
            f.waited(field, f.HAS_WELL, well)
            f.waited(field, f.DRAINED)
            got = tf.query(f'select id, org_id, created_by from public.boreholes where name = {tf.text_lit(well)}')
            m.made.extend(r['id'] for r in got)
            check('the Driller captures a borehole in the field app and it reaches the server in that organization',
                  [(r['org_id'], r['created_by']) for r in got] == [(org, od.id)], m.short(got))
            ctx.close()

            print('\n== B. the audit trail ==', flush=True)
            action = page.get_by_label('Action')
            for act, done in (('extend', 'Extend: done.'), ('suspend', 'Suspend: done.'),
                              ('reactivate', 'Reactivate: done.')):
                action.select_option(act)
                if act == 'extend':
                    page.get_by_label('New end date').fill('2027-03-31')
                page.get_by_role('button', name='Apply').click()
                seen(page, done)
            check('suspending from the console asks for confirmation', len(asked) == 1 and name in asked[0], m.short(asked))
            log = tf.query(f'select action, actor_id, target, details, at >= {tf.text_lit(t0)}::timestamptz'
                           f' and at <= now() as in_run from public.audit_log where org_id = {tf.uid(org)} order by id')
            d = lambda r: r.get('details') or {}  # noqa: E731
            ends = lambda r, k: str((d(r).get(k) or {}).get('ends_at'))  # noqa: E731
            state = lambda r, k: (d(r).get(k) or {}).get('status')  # noqa: E731
            want = [('org.create', pa, None, lambda r: d(r).get('status') == 'trial'
                     and str(d(r).get('ends_at')).startswith('2027-01-31T23:59:59')),
                    ('member.add', pa, oa, lambda r: d(r).get('role') == 'Administrator'),
                    ('member.add', oa, od, lambda r: d(r).get('role') == 'Driller'),
                    ('subscription.extend', pa, None, lambda r: ends(r, 'before').startswith('2027-01-31T23:59:59')
                     and ends(r, 'after').startswith('2027-03-31T23:59:59')),
                    ('subscription.suspend', pa, None, lambda r: (state(r, 'before'), state(r, 'after')) == ('trial', 'suspended')),
                    ('subscription.reactivate', pa, None, lambda r: state(r, 'before') == 'suspended'
                     and state(r, 'after') not in ('suspended', None))]
            check('the audit log holds exactly these rows for the organization, in order',
                  [r['action'] for r in log] == [w[0] for w in want], m.short([r['action'] for r in log], 300))
            for (act, actor, target, details), r in zip(want, log):
                check(f'{act} by {actor.label}: actor, time, target and details',
                      r['actor_id'] == actor.id and r['in_run'] and r['target'] == (target and target.id)
                      and details(r), m.short(r, 300))
            seen(page, 'subscription.reactivate')
            cells = page.locator('section:has(h2:text("Audit history")) tbody tr').evaluate_all(
                'rows => rows.map(r => [...r.cells].map(c => c.innerText.trim()))')
            emails = {pa.id: pa.email, oa.id: oa.email}
            check('the console\'s audit list for the organization shows each, with its actor and time',
                  sorted((c[1], c[2]) for c in cells if len(c) == 4 and c[0]) ==
                  sorted((emails[w[1].id], w[0]) for w in want), m.short(cells, 300))

            print('\n== C. non-platform accounts ==', flush=True)
            sa = fx['sa']
            other = console(browser, sa, errors)
            shown = seen(other, REFUSAL)
            body = other.inner_text('body')
            check('an organization\'s Administrator opening the console sees the refusal sentence and no data',
                  shown and 'New organization' not in body and 'Audit history' not in body
                  and name not in body and fx.second_name not in body, m.short(body))
            before = tf.query(f'select md5(s::text) as d from public.subscriptions s where org_id = {tf.uid(org)}')
            got = {fn: rpc(fn, sa, org) for fn in FUNCTIONS}
            check('that Administrator calling each platform function directly gets 403 with code 42501, nothing changed',
                  all(g == (403, '42501') for g in got.values()) and not tf.query(
                      f"select 1 from public.organizations where name = {tf.text_lit(f'TISO {fx.run} refused')}")
                  and tf.query(f'select md5(s::text) as d from public.subscriptions s where org_id = {tf.uid(org)}') == before,
                  m.short(got, 300))
            got = {fn: rpc(fn, None, org) for fn in FUNCTIONS}
            check('anon calling each platform function gets 401 with code 42501',
                  all(g == (401, '42501') for g in got.values()), m.short(got, 300))
            email, members = fx.email('second-admin'), tf.query(f'select user_id from public.memberships where org_id = {tf.uid(org)}')
            status, body = m.fn('POST', pa, org, email=email, name='x', role='Administrator', password=uuid.uuid4().hex + 'Aa1')
            check('the platform path of saas-members refuses a second Administrator; no account, no membership (D4-6)',
                  400 <= status < 500 and fx.account_by_email(email) is None and tf.query(
                      f'select user_id from public.memberships where org_id = {tf.uid(org)}') == members,
                  f'HTTP {status} {m.short(body)}')

            print('\n== D. no Drill record for the platform administrator (D4-1) ==', flush=True)
            status, body = m.rest('GET', '/boreholes?select=id', pa)
            check('the platform administrator reads no borehole of any organization, while the new one exists',
                  status == 200 and body == [] and got_well(well), f'HTTP {status} {m.short(body)}')
            check('no JS errors', not errors, m.short(errors[:2]))
            browser.close()
    finally:
        tf.sql(f'delete from public.platform_admins where user_id = {tf.uid(pa.id)};'
               f' delete from public.audit_log where actor_id = {tf.uid(pa.id)}'
               + (f' or org_id = {tf.uid(org)};' if org else ';'))


def got_well(well):
    return bool(tf.query(f'select 1 from public.boreholes where name = {tf.text_lit(well)}'))


if __name__ == '__main__':
    m.run(checks)
