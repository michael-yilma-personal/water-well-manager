"""Member management through the deployed Edge Function `saas-members`, proved
with real sign-ins and two organizations against the project named by _target
(IMPLEMENTATION_STATUS: P2-2 criterion 9 with 1 to 5; P2-1 criteria 22 and 23;
decisions D2-1 and D2-5; RF-102, RF-103, RF-110).

  1. no Administrator manages the other organization; non-administrators, a
     deactivated Administrator and an invited Administrator are refused
  2. a new email becomes an account of the second organization only
  3. an existing account is only invited, which gives nothing until accepted
  4. deactivating in one organization leaves the other one, and the account
  5. removing a member without records leaves the account
  6. the project is left as it was found

Needs DRILL_E2E_DB_URL and DRILL_E2E_SERVICE_ROLE_KEY in the environment (see
tenant_fixture.py). The fixture is removed also after a failure or interrupt.

Run:  python3 e2e/saas/members_e2e.py    (exit 0 only if every check passes)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import _target  # noqa: E402,F401  (the path line above has to come first)

import signal  # noqa: E402
import traceback  # noqa: E402
import uuid  # noqa: E402

import tenant_fixture as tf  # noqa: E402

results = []
made = []          # every record id this run sent
fx = tf.Fixture()


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''), flush=True)
    return bool(ok)


def short(value, n=160):
    return ' '.join(str(value).split())[:n]


def rest(method, path, account, body=None):
    status, raw = tf.request(method, '/rest/v1' + path, token=account.token, body=body)
    return status, tf.parse(raw)


def fn(method, account, org, **fields):
    """`saas-members` as `account`, naming `org` the way the method requires."""
    if method == 'GET':
        status, raw = tf.request('GET', f'/functions/v1/saas-members?org_id={org}', token=account.token)
    else:
        status, raw = tf.request(method, '/functions/v1/saas-members', token=account.token,
                                 body={'org_id': org, **fields})
    return status, tf.parse(raw)


def borehole(author, org, name):
    """One named borehole of `author` in `org`; its id."""
    rid = str(uuid.uuid4())
    made.append(rid)
    status, body = rest('POST', '/boreholes', author, {
        'id': rid, 'created_by': author.id, 'recorded_at': '2026-11-25T08:00:00Z',
        'name': name, 'project': 'members e2e', 'org_id': org})
    if not 200 <= status < 300:
        raise tf.FixtureError(f'could not create the borehole {name}: HTTP {status} {short(body)}')
    return rid


def sees(account, rid):
    """Whether `account` reads the borehole `rid`."""
    status, body = rest('GET', f'/boreholes?select=id&id=eq.{rid}', account)
    return status == 200 and isinstance(body, list) and len(body) == 1


def memberships(account_id):
    """Sorted (org, role, status) of one account, read from the database."""
    state = fx.account_state([account_id]).get(account_id)
    return None if state is None else sorted((m['org'], m['role'], m['status']) for m in state['memberships'])


# --------------------------------------------------------------------------
# the checks
# --------------------------------------------------------------------------

def member_management():
    F, S = fx.founding, fx.second
    fa, sa, fv, sd = fx['fa'], fx['sa'], fx['fv'], fx['sd']
    f_well = borehole(fv, F, f'TISO {fx.run} founding well')
    s_well = borehole(sd, S, f'TISO {fx.run} second well')

    print('\n== 1. who may manage an organization ==', flush=True)
    before = fx.all_memberships()
    for admin, tag, org, victim in ((fa, 'second', S, sd), (sa, 'founding', F, fv)):
        stray = fx.email('stray-' + tag)
        got = [fn('GET', admin, org)[0],
               fn('POST', admin, org, email=stray, name='x', role='Driller', password=uuid.uuid4().hex)[0],
               fn('PATCH', admin, org, id=victim.id, action='deactivate')[0],
               fn('DELETE', admin, org, id=victim.id)[0]]
        check(f'the Administrator of the other organization gets 403 for GET, POST, PATCH and DELETE'
              f' naming the {tag} organization', got == [403] * 4, f'HTTP {got}')
        check(f'and no account was created by the refused POST ({tag})', fx.account_by_email(stray) is None)
    check('no membership anywhere changed through the refused requests', fx.all_memberships() == before)

    fx.set_membership_status(fx['fx'], F, 'deactivated')
    for label, what in (('fd', 'a Driller'), ('fl', 'a Data Logger'), ('fs', 'a Supervisor'),
                        ('fx', 'a deactivated Administrator')):
        status, body = fn('GET', fx[label], F)
        check(f'{what} of the organization gets 403', status == 403, f'HTTP {status} {short(body)}')

    print('\n== 2. a new email: an account of the second organization only ==', flush=True)
    new_email, new_secret = fx.email('new'), uuid.uuid4().hex + 'Aa1'
    status, body = fn('POST', sa, S, email=new_email, name=f'TISO new {fx.run}', role='Driller',
                      badgeNumber='TISO-NEW', password=new_secret)
    created = status == 201 and isinstance(body, dict) and body.get('outcome') == 'created'
    check('POST for a new email in the second organization answers 201 created', created,
          f'HTTP {status} {short(body)}')
    new_id = fx.account_by_email(new_email)
    check('the id in the answer is the new account', created and new_id is not None and body.get('id') == new_id)
    if new_id:
        new = fx.add_account('new', new_email, new_id, new_secret)
        check('the new account can sign in with the password given', new.sign_in())
        got = memberships(new_id)
        check('it has exactly one membership: the second organization, active',
              got == [(S, 'Driller', 'active')], short(got))
        check('it has NO membership in the founding organization (RF-102, real auth server)',
              new_id not in fx.founding_members() and not any(m[0] == F for m in got or []), short(got))

    print('\n== 3. an existing account is only invited ==', flush=True)
    account_before = fx.account_state([fv.id])[fv.id]
    status, body = fn('POST', sa, S, email=fv.email, name='ignored', role='Administrator',
                      password=uuid.uuid4().hex)
    check('POST for an email that already has an account answers 201 invited, with that account\'s id',
          status == 201 and isinstance(body, dict) and body.get('outcome') == 'invited'
          and body.get('id') == fv.id, f'HTTP {status} {short(body)}')
    status, body = rest('POST', '/rpc/my_organizations', fv, {})
    mine = sorted((r.get('org_id'), r.get('role'), r.get('status')) for r in body) if isinstance(body, list) else body
    check('my_organizations() shows the invited person the invitation, as invited',
          mine == sorted([(F, 'Driller', 'active'), (S, 'Administrator', 'invited')]), short(mine))
    check('control: a member of the second organization reads its borehole', sees(sd, s_well))
    check('the invited person reads none of the second organization\'s records', not sees(fv, s_well))
    status, body = fn('GET', fv, S)
    check('an invited Administrator gets 403 from the function', status == 403, f'HTTP {status} {short(body)}')
    status, body = rest('GET', f'/profiles?select=id,name&id=eq.{fv.id}', sa)
    check('the inviting Administrator cannot read the invited person\'s profiles row (RF-103)',
          status == 200 and body == [], f'HTTP {status} {short(body)}')
    status, body = fn('GET', sa, S)
    listed = {m.get('id'): m for m in body.get('members', [])} if status == 200 and isinstance(body, dict) else {}
    row = listed.get(fv.id) or {}
    check('the member list is the second organization\'s members and nobody else',
          set(listed) == {r['user_id'] for r in fx.all_memberships() if r['org_id'] == S}
          and (listed.get(sa.id) or {}).get('isSelf') is True, f'HTTP {status} {len(listed)} listed')
    check('the list shows the invitation by email, with no name and no last sign-in (RF-110)',
          row.get('status') == 'invited' and row.get('email') == fv.email and row.get('name') == ''
          and row.get('lastSignInAt') is None, short(row))

    status, body = rest('POST', '/rpc/accept_membership', fv, {'org': S})
    check('accept_membership succeeds for the invited person', 200 <= status < 300, f'HTTP {status} {short(body)}')
    got = memberships(fv.id)
    check('after accepting, the membership is active and the founding one is as it was',
          got == sorted([(F, 'Driller', 'active'), (S, 'Administrator', 'active')]), short(got))
    check('and the person now reads the second organization\'s records', sees(fv, s_well))

    print('\n== 4. deactivated in one organization only (D2-5) ==', flush=True)
    status, body = fn('PATCH', sa, S, id=fv.id, action='deactivate')
    check('PATCH deactivate by the second organization\'s Administrator succeeds',
          status == 200, f'HTTP {status} {short(body)}')
    got = memberships(fv.id)
    check('only the membership in the second organization is deactivated',
          got == sorted([(F, 'Driller', 'active'), (S, 'Administrator', 'deactivated')]), short(got))
    check('the person no longer reads the second organization\'s records', not sees(fv, s_well))
    check('the person still reads their founding records', sees(fv, f_well))
    account_after = fx.account_state([fv.id])[fv.id]
    check('the account can still sign in: not banned, password untouched',
          fv.sign_in() and account_after['banned'] is False
          and account_after['credential'] == account_before['credential'])

    print('\n== 5. removing a member with no records ==', flush=True)
    if new_id:
        status, body = fn('DELETE', sa, S, id=new_id)
        check('DELETE of a member with no records answers removed',
              status == 200 and isinstance(body, dict) and body.get('action') == 'removed'
              and body.get('records') == 0, f'HTTP {status} {short(body)}')
        check('the membership is gone and the auth account still exists and signs in',
              memberships(new_id) == [] and fx['new'].sign_in(), short(memberships(new_id)))


# --------------------------------------------------------------------------
# run (also used by dashboard_orgs_e2e.py)
# --------------------------------------------------------------------------

def left_as_found():
    print('\n== the project is left as it was found ==', flush=True)
    state = fx.end_state()
    check('no account or organization named by the fixture is left',
          state['fixture_accounts'] == 0 and state['fixture_organizations'] == 0,
          f'{state["fixture_accounts"]} account(s), {state["fixture_organizations"]} organization(s)')
    left = fx.record_state(made) if made else {}
    check('none of the rows this run sent is left in the record tables', not left, f'{len(left)} row(s)')
    if fx.baseline is None:
        check('the state before the run was recorded, to compare with', False)
        return
    before, after = fx.baseline, state['fingerprint']
    for what in ('accounts', 'profiles', 'memberships', 'organizations', 'platform_admins'):
        check(f'{what}: identical to before the run (count and content)',
              after['exact'].get(what) == before['exact'].get(what),
              f'{before["exact"].get(what, ["?"])[0]} before, {after["exact"].get(what, ["?"])[0]} after')
    for what in tf.RECORD_TABLES + ('photos',):
        b, a = before['rows'][what], after['rows'][what]
        damaged = [k for k in b if a.get(k) != b[k]]
        check(f'{what}: every row that existed before the run is still there, unchanged',
              not damaged, f'{len(b)} before, {len(a)} after, {len(damaged)} missing or changed')


def _interrupted(signum, _frame):
    raise KeyboardInterrupt(f'signal {signum}')


def run(checks):
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, _interrupted)
    try:
        fx.set_up()
        check('the fixture is set up: a second organization and its accounts', True,
              f'run {fx.run}; removed from an earlier run: {fx.swept_at_start}')
        checks()
    except BaseException as error:  # the tear-down below must run whatever happened
        traceback.print_exc()
        check('the suite ran to completion', False, f'{type(error).__name__}: {short(error, 300)}')
    finally:
        try:
            check('the fixture is removed', True, str(fx.tear_down()))
            left_as_found()
        except Exception as error:
            check('the fixture is removed and the end state read', False,
                  f'{type(error).__name__}: {short(error, 300)}')
    failed = [name for name, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} passed')
    for name in failed:
        print(f'  FAILED: {name}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    run(member_management)
