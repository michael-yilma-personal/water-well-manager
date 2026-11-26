"""Subscriptions (SaaS Phase 3) with real sign-ins, against the project named
by _target: the three phase acceptance points of proposal section 8.

  A. each state of the section 8 table: sign-in, read, write, manage members
  B. the user limit cannot be exceeded
  C. one organization's suspension leaves the other organization alone
  D. in a browser: work captured during a lapse uploads after renewal; the
     notices of both apps

Only the fixture's second organization is ever given another subscription; the
founding organization's is compared before and after.

Same needs, fixture, tear-down and end-state checks as members_e2e.py.

Run:  python3 e2e/saas/subscriptions_e2e.py    (exit 0 only if every check passes)
"""
import uuid

import field_orgs_e2e as f
import members_e2e as m
from dashboard_orgs_e2e import seen, signed_in
from members_e2e import check, fx

import _target
import tenant_fixture as tf
from playwright.sync_api import sync_playwright

# state, stored status, days until the end date (grace is 7 days), org_access()
STATES = (('trial', 'trial', 10, 'full'), ('active', 'active', 10, 'full'),
          ('within grace', 'active', -1, 'full'), ('expired', 'active', -30, 'read_only'),
          ('suspended', 'suspended', 10, 'none'), ('canceled', 'canceled', 10, 'none'))
# HTTP of saas-members for: list, deactivate a member, re-activate that member
MANAGE = {'full': [200, 200, 200], 'read_only': [200, 200, 402], 'none': [402, 402, 402]}
FOUNDING_SUBSCRIPTION = ('select md5(s::text) as digest from public.subscriptions s'
                         ' join public.organizations o on o.id = s.org_id where o.is_founding')
EXPIRED, GRACE, INACTIVE = 'subscription has expired', 'subscription ended on', 'subscription is not active'
sentence = {}   # access -> the sentence saas-members refused with


def subscription(status, days=None, limit=None):
    """Set the SECOND organization's subscription (never the founding one's)."""
    ends = 'null' if days is None else f"now() + interval '{int(days)} days'"
    tf.sql(f'update public.subscriptions set status = {tf.text_lit(status)}, ends_at = {ends},'
           f" max_users_override = {'null' if limit is None else int(limit)}"
           f' where org_id = {tf.uid(fx.second)}'
           ' and org_id in (select id from public.organizations where not is_founding);')


def write(author, org):
    """A new borehole sent by `author`: (HTTP status, body, whether it is stored)."""
    rid = str(uuid.uuid4())
    m.made.append(rid)
    status, body = m.rest('POST', '/boreholes', author, {
        'id': rid, 'created_by': author.id, 'recorded_at': '2026-11-25T08:00:00Z',
        'name': f'TISO {fx.run} {rid[:8]}', 'project': 'subscriptions e2e', 'org_id': org})
    return status, body, rid in fx.record_state([rid])


def states(s_well, f_well):
    F, S = fx.founding, fx.second
    sa, sd, sx, fd = fx['sa'], fx['sd'], fx['sx'], fx['fd']
    for state, stored, days, access in STATES:
        print(f'\n== A. {state} ==', flush=True)
        subscription(stored, days)
        status, body = m.rest('POST', '/rpc/my_organizations', sd, {})
        mine = [(r.get('org_id'), r.get('status'), r.get('access')) for r in body] if isinstance(body, list) else body
        check(f'{state}: a member signs in and my_organizations() gives access {access}',
              sd.sign_in() and mine == [(S, 'active', access)], f'HTTP {status} {m.short(mine)}')
        check(f'{state}: a member {"reads" if access != "none" else "reads none of"} the organization\'s records',
              m.sees(sd, s_well) == (access != 'none'))
        status, body, kept = write(sd, S)
        check(f'{state}: a new record is ' + ('accepted' if access == 'full' else 'refused with code SS002, HTTP 400'),
              (200 <= status < 300 and kept) if access == 'full' else
              (status == 400 and isinstance(body, dict) and body.get('code') == 'SS002' and not kept),
              f'HTTP {status} {m.short(body)}')
        got = [m.fn('GET', sa, S), m.fn('PATCH', sa, S, id=sx.id, action='deactivate'),
               m.fn('PATCH', sa, S, id=sx.id, action='reactivate')]
        refused = [b.get('error') for s, b in got if s == 402 and isinstance(b, dict)]
        sentence[access] = refused[0] if refused else None
        left = 'deactivated' if access == 'read_only' else 'active'
        check(f'{state}: saas-members answers {MANAGE[access]} for list, deactivate, re-activate;'
              ' a refusal is one sentence about the subscription',
              [s for s, _ in got] == MANAGE[access] and m.memberships(sx.id) == [(S, 'Supervisor', left)]
              and all(isinstance(e, str) and 'subscription' in e and '. ' not in e for e in refused),
              f'HTTP {[s for s, _ in got]} {m.short(refused[:1])}')
        fx.set_membership_status(sx, S, 'active')
        if state == 'suspended':
            print('\n== C. the other organization ==', flush=True)
            status, body, kept = write(fd, F)
            check('while the second organization is suspended, a founding member reads and writes founding records',
                  m.sees(fd, f_well) and 200 <= status < 300 and kept, f'HTTP {status} {m.short(body)}')


def user_limit():
    print('\n== B. the user limit ==', flush=True)
    S, email = fx.second, fx.email('over')
    count = lambda: tf.query('select count(*) as n from public.memberships where org_id ='  # noqa: E731
                             f" {tf.uid(S)} and status in ('active', 'invited')")[0]['n']
    before = count()
    subscription('active', limit=before)
    status, body = m.fn('POST', fx['sa'], S, email=email, name='x', role='Driller', password=uuid.uuid4().hex + 'Aa1')
    check('at the user limit, adding a member is 409 with the user-limit sentence; no member and no account is added',
          status == 409 and isinstance(body, dict) and 'user limit' in str(body.get('error')) and count() == before
          and fx.account_by_email(email) is None,
          f'HTTP {status} {m.short(body)}; {before} before, {count()} after')
    subscription('active')


def browser(s_well):
    S, sd, sa = fx.second, fx['sd'], fx['sa']
    errors = []
    with sync_playwright() as p:
        chromium = p.chromium.launch()

        print('\n== D. the field app through a lapse ==', flush=True)
        ctx, page = f.linked(chromium, sd, errors)
        f.waited(page, f.HAS_WELL, s_well)
        subscription('active', -30)
        pipes = [o['entityId'] for o in f.log_offline(ctx, page, s_well) if o['entity'] == 'pipeRecord']
        ctx.set_offline(False)
        page.evaluate("() => window.dispatchEvent(new Event('online'))")
        check('expired: the field app shows the expired notice', seen(page, EXPIRED))
        check('expired: the pipe captured during the lapse stays queued, is not parked, and is not on the server',
              len(pipes) == 1 and not f.waited(page, f.PARKED, timeout=15000) and page.evaluate(f.QUEUED)
              and not fx.record_state(pipes),
              m.short([(o['entity'], o.get('parked'), o.get('lastError')) for o in f.stored(page, 'wwdm_outbox')], 300))
        subscription('active')
        ctx.set_offline(True)   # signal lost and back: one of the moments the app reads the subscription again
        page.evaluate("() => window.dispatchEvent(new Event('offline'))")
        drained = f.back_online(ctx, page)
        row = (fx.record_state(pipes).get(pipes[0]) or {}).get('row') or {} if pipes else {}
        check('renewed: when signal returns the pipe is on the server, in its organization, by its author',
              drained and (row.get('org_id'), row.get('created_by')) == (S, sd.id),
              m.short(f.stored(page, 'wwdm_outbox'), 300))
        check('renewed: the notice is gone',
              f.waited(page, f"() => !document.body.innerText.includes('{EXPIRED}')", timeout=20000))

        subscription('active', -1)
        page.reload(wait_until='networkidle')
        check('within grace: the field app shows the renewal notice', seen(page, GRACE))
        subscription('suspended')
        page.reload(wait_until='networkidle')
        shown = seen(page, INACTIVE)
        body = page.inner_text('body')
        check('suspended: the field app shows "subscription not active", no record, and Sign out',
              shown and s_well not in body and 'START PIPE' not in body
              and page.get_by_role('button', name='Sign out').count() == 1)
        ctx.close()

        print('\n== D. the dashboard, expired ==', flush=True)
        subscription('active', -30)
        page = signed_in(chromium, _target.start_app(), sa, errors)
        check('expired: the dashboard lists the records and shows the expired notice',
              seen(page, s_well) and seen(page, EXPIRED))
        email = fx.email('late')
        page.get_by_role('button', name='Crew').click()
        page.get_by_role('button', name='Add crew member').click()
        page.fill('input[type="email"]', email)
        page.fill('input[placeholder="at least 8 characters"]', uuid.uuid4().hex + 'Aa1')
        page.fill('input[placeholder="Joe Kamau"]', 'TISO late')
        page.get_by_role('button', name='Create account').click()
        check('expired: adding a member shows the server\'s sentence, and nobody is added',
              bool(sentence.get('read_only')) and seen(page, sentence['read_only'])
              and fx.account_by_email(email) is None, m.short(sentence.get('read_only')))
        check('no JS errors', not errors, m.short(errors[:2]))
        chromium.close()
    subscription('active')


def checks():
    founding = tf.query(FOUNDING_SUBSCRIPTION)
    s_well, f_well = f'TISO {fx.run} second well', f'TISO {fx.run} founding well'
    s_id = m.borehole(fx['sd'], fx.second, s_well)
    f_id = m.borehole(fx['fd'], fx.founding, f_well)
    try:
        states(s_id, f_id)
        user_limit()
        browser(s_well)
    finally:
        check('the founding organization\'s subscription is exactly as before',
              len(founding) == 1 and tf.query(FOUNDING_SUBSCRIPTION) == founding)


if __name__ == '__main__':
    m.run(checks)
