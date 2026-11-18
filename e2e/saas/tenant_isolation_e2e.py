"""Tenant isolation, proved with real sign-ins against the project named by
_target (IMPLEMENTATION_STATUS criteria 10 to 12, 15, 18 to 20, 30, 32 to 36,
43; proposal section 10).

Two organizations - the founding one (F) and a second one (S) made by the
fixture - each with a Driller, a Supervisor and an Administrator; one user who
belongs to both; members deactivated mid-run. Every request is a real HTTP
request as a signed-in user: PostgREST, the Storage API, the `admin-users`
Edge Function. What a request must not have changed is then read back from
the database itself, so a refusal that quietly did the work would be seen.

  1. the fixture is what the checks assume
  2. each role still does what it could, in its own organization
  3. criterion 12 on the four record tables, both directions, every verb
  4. the member of both organizations
  5. profiles
  6. memberships, organizations and the helper functions
  7. photos, on the new path and the legacy path
  8. deactivated members
  9. `admin-users` as deployed
 10. the project is left as it was found

Needs, besides what _target needs, DRILL_E2E_DB_URL and
DRILL_E2E_SERVICE_ROLE_KEY in the environment (see tenant_fixture.py). The
fixture is removed in a `finally`, also after a failure or an interrupt.

Run:  python3 e2e/saas/tenant_isolation_e2e.py    (exit 0 only if every check passes)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import _target  # noqa: E402  (the path line above has to come first)

import json  # noqa: E402
import signal  # noqa: E402
import traceback  # noqa: E402
import uuid  # noqa: E402

import tenant_fixture as tf  # noqa: E402

TABLES = tf.RECORD_TABLES
CHILDREN = tf.CHILD_TABLES
BUCKET = tf.BUCKET
TS = '2026-11-17T08:00:00Z'
LATER = '2026-11-17T09:00:00Z'
# The column that carries a row's recognisable text, per table.
MARK = {'boreholes': 'project', 'pipe_records': 'remarks', 'drilling_events': 'title',
        'shift_logs': 'notes'}
# A column the author may change that is not the mark.
OTHER = {'boreholes': 'client', 'pipe_records': 'operator', 'drilling_events': 'operator',
         'shift_logs': 'driller_name'}

results = []
notes = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(f'{"PASS" if ok else "FAIL"}  {name}' + (f'   -- {detail}' if detail else ''), flush=True)
    return bool(ok)


def note(text):
    notes.append(text)
    print(f'NOTE  {text}', flush=True)


def section(title):
    print(f'\n== {title} ==', flush=True)


def short(value, n=140):
    return ' '.join(str(value).split())[:n]


fx = tf.Fixture()
RUN = fx.run
made = []          # every record id this run sent, whether or not it was accepted
_counter = [0]


def new_id():
    rid = str(uuid.uuid4())
    made.append(rid)
    return rid


def next_number():
    _counter[0] += 1
    return _counter[0]


# --------------------------------------------------------------------------
# requests
# --------------------------------------------------------------------------

def rest(method, path, account, body=None, prefer=None):
    """PostgREST as `account` (None = not signed in)."""
    status, raw = tf.request(method, '/rest/v1' + path, token=account.token if account else None,
                             body=body, headers={'Prefer': prefer} if prefer else None)
    return status, tf.parse(raw)


def rpc(name, account, args=None):
    return rest('POST', f'/rpc/{name}', account, body=args or {})


def fn(method, account, body=None, token=None, auth=True):
    """The admin-users function. `account` signs the request unless `token`
    is given; auth=False sends no Authorization header."""
    bearer = token if token is not None else (account.token if account else None)
    status, raw = tf.request(method, '/functions/v1/admin-users', token=bearer, body=body, auth=auth)
    return status, tf.parse(raw)


def good(status):
    return 200 <= status < 300


def code(body):
    return body.get('code') if isinstance(body, dict) else None


def no_effect(status, body):
    """A write that reports having touched nothing: an error, or no rows."""
    return not good(status) or body == [] or body is None


def record(table, rid, author, borehole=None, org=None, mark='x'):
    row = {'id': rid, 'created_by': author.id, 'recorded_at': TS}
    if table == 'boreholes':
        row.update(name=f'TISO {RUN} borehole', project=mark)
    elif table == 'pipe_records':
        row.update(borehole_id=borehole, pipe_number=next_number(), remarks=mark)
    elif table == 'drilling_events':
        row.update(borehole_id=borehole, type='note', title=mark)
    else:
        row.update(borehole_id=borehole, shift_name='Day', notes=mark)
    if org:
        row['org_id'] = org
    return row


def create(table, author, borehole=None, org=None, mark='x'):
    rid = new_id()
    status, body = rest('POST', f'/{table}', author, record(table, rid, author, borehole, org, mark),
                        prefer='return=representation')
    row = body[0] if good(status) and isinstance(body, list) and body else None
    return rid, status, body, row


# -- storage ---------------------------------------------------------------

def photo_bytes(label):
    return b'\xff\xd8\xff\xe0' + f'TISO-PHOTO-{RUN}-{label}-{uuid.uuid4().hex}'.encode()


def upload(account, path, data, upsert=False, method='POST'):
    headers = {'Content-Type': 'image/jpeg'}
    if upsert:
        headers['x-upsert'] = 'true'
    status, raw = tf.request(method, f'/storage/v1/object/{BUCKET}/{path}',
                             token=account.token if account else None, data=data, headers=headers)
    return status, tf.parse(raw)


def download(account, path):
    return tf.request('GET', f'/storage/v1/object/authenticated/{BUCKET}/{path}',
                      token=account.token if account else None)


def reads(account, path, data):
    status, raw = download(account, path)
    return status == 200 and raw == data


def signed_content(account, path):
    """(status of the signing request, the bytes the signed URL serves or None)."""
    status, raw = tf.request('POST', f'/storage/v1/object/sign/{BUCKET}/{path}',
                             token=account.token if account else None, body={'expiresIn': 60})
    body = tf.parse(raw)
    link = body.get('signedURL') or body.get('signedUrl') if isinstance(body, dict) else None
    if not good(status) or not link:
        return status, None
    s2, content = tf.request('GET', '/storage/v1' + link, auth=False)
    return status, content if s2 == 200 else None


def listing(account, prefix):
    status, raw = tf.request('POST', f'/storage/v1/object/list/{BUCKET}',
                             token=account.token if account else None,
                             body={'prefix': prefix, 'limit': 1000, 'offset': 0})
    body = tf.parse(raw)
    return [o.get('name') for o in body] if status == 200 and isinstance(body, list) else []


def storage_post(account, action, body):
    status, raw = tf.request('POST', f'/storage/v1/object/{action}', token=account.token, body=body)
    return status, tf.parse(raw)


def storage_delete(account, path):
    status, raw = tf.request('DELETE', f'/storage/v1/object/{BUCKET}/{path}', token=account.token)
    return status, tf.parse(raw)


# --------------------------------------------------------------------------
# the two organizations as the suite sees them
# --------------------------------------------------------------------------

class Org:
    def __init__(self, tag, org_id, driller, supervisor, admin):
        self.tag = tag
        self.id = org_id
        self.driller = driller
        self.supervisor = supervisor
        self.admin = admin
        self.rows = {}        # table -> id of the row the other organization goes after
        self.secret = {}      # table -> its recognisable text
        self.pipe2 = None     # a pipe record reviewers correct (not a victim row)
        self.spare = {}       # table -> a row of the Driller's that is not a victim row
        self.baseline = {}    # id -> whole row, read from the database

    def secrets(self):
        return list(self.secret.values())


F = S = None


def leaked(body, secrets):
    text = json.dumps(body) if not isinstance(body, str) else body
    return [s for s in secrets if s in text]


# --------------------------------------------------------------------------
# 1. the fixture
# --------------------------------------------------------------------------

def check_fixture():
    section('1. the fixture is what the checks assume')
    state = fx.account_state([a.id for a in fx.accounts.values()])
    want = fx.expected_memberships()
    wrong = []
    for label, account in fx.accounts.items():
        row = state.get(account.id)
        got = sorted((m['org'], m['role'], m['status']) for m in row['memberships']) if row else None
        if got != want[label]:
            wrong.append(f'{label}: {got}')
    check('every fixture account has exactly the memberships intended (second-organization'
          ' accounts have none in the founding one)', not wrong, '; '.join(wrong))
    check('fixture: one account has profiles.role Administrator and a founding membership Driller',
          state[fx['fp'].id]['profile_role'] == 'Administrator')
    check('fixture: one account has profiles.role Driller and a founding membership Administrator',
          state[fx['fh'].id]['profile_role'] == 'Driller')
    orgs = fx.organizations()
    check('exactly two organizations exist during the run, one of them founding',
          len(orgs) == 2 and sorted(o['is_founding'] for o in orgs) == [False, True],
          short([o['name'] for o in orgs]))


# --------------------------------------------------------------------------
# 2. each role in its own organization
# --------------------------------------------------------------------------

def seed(org):
    """The organization's Driller logs one row per table, as a real user."""
    d = org.driller
    for table in TABLES:
        org.secret[table] = f'TISO-SECRET-{RUN}-{org.tag}-{table}-{uuid.uuid4().hex[:10]}'

    # the borehole goes without org_id, as an installed build sends it
    rid, status, body, row = create('boreholes', d, mark=org.secret['boreholes'])
    org.rows['boreholes'] = rid
    check(f'[{org.tag}] Driller creates a borehole without org_id and it lands in their only'
          ' organization', good(status) and row is not None and row.get('org_id') == org.id,
          f'HTTP {status} {short(body)}')
    for table in CHILDREN:
        rid, status, body, row = create(table, d, borehole=org.rows['boreholes'],
                                        mark=org.secret[table])
        org.rows[table] = rid
        check(f'[{org.tag}] Driller logs a row in {table}; it takes the borehole\'s organization',
              good(status) and row is not None and row.get('org_id') == org.id,
              f'HTTP {status} {short(body)}')
    rid, status, body, row = create('pipe_records', d, borehole=org.rows['boreholes'],
                                    mark='second pipe')
    org.pipe2 = rid
    check(f'[{org.tag}] Driller logs a second pipe record', good(status), f'HTTP {status} {short(body)}')
    made_spares = []
    for table in TABLES:
        bh = org.rows['boreholes'] if table != 'boreholes' else None
        rid, status, body, row = create(table, d, borehole=bh, mark='spare')
        org.spare[table] = rid
        made_spares.append(good(status))
    check(f'[{org.tag}] Driller logs one more row per table', all(made_spares))


def roles(org, outsider=None):
    d, s, a = org.driller, org.supervisor, org.admin
    t = org.tag

    # --- Driller: read own, change own, soft-delete own, never hard-delete ---
    for table in TABLES:
        status, body = rest('GET', f'/{table}?id=eq.{org.rows[table]}&select=id,org_id', d)
        check(f'[{t}] Driller reads their own row in {table}',
              status == 200 and body == [{'id': org.rows[table], 'org_id': org.id}],
              f'HTTP {status} {short(body)}')
        status, body = rest('PATCH', f'/{table}?id=eq.{org.rows[table]}', d,
                            {OTHER[table]: 'changed by its author'}, prefer='return=representation')
        check(f'[{t}] Driller changes their own row in {table}',
              status == 200 and isinstance(body, list) and len(body) == 1
              and body[0].get(OTHER[table]) == 'changed by its author', f'HTTP {status} {short(body)}')

        bh = org.rows['boreholes'] if table != 'boreholes' else None
        rid, status, body, row = create(table, d, borehole=bh, org=org.id, mark='throwaway')
        check(f'[{t}] Driller inserts into {table} naming their own organization',
              good(status) and row is not None and row.get('org_id') == org.id,
              f'HTTP {status} {short(body)}')
        status, body = rest('PATCH', f'/{table}?id=eq.{rid}', d, {'deleted_at': LATER},
                            prefer='return=representation')
        check(f'[{t}] Driller soft-deletes their own row in {table}',
              status == 200 and isinstance(body, list) and len(body) == 1
              and body[0].get('deleted_at') is not None, f'HTTP {status} {short(body)}')
        status, body = rest('DELETE', f'/{table}?id=eq.{rid}', d, prefer='return=representation')
        still = rest('GET', f'/{table}?id=eq.{rid}&select=id', d)[1]
        check(f'[{t}] nobody hard-deletes: the author\'s DELETE on {table} removes nothing',
              no_effect(status, body) and still == [{'id': rid}], f'HTTP {status} {short(body)}')

    # --- Supervisor: reads the organization, inserts, corrects a pipe record ---
    for table in TABLES:
        status, body = rest('GET', f'/{table}?id=eq.{org.rows[table]}&select=id', s)
        check(f'[{t}] Supervisor reads the Driller\'s row in {table}',
              status == 200 and body == [{'id': org.rows[table]}], f'HTTP {status} {short(body)}')
    status, body = rest('PATCH', f'/pipe_records?id=eq.{org.pipe2}', s,
                        {'formation': 'Weathered Basalt'}, prefer='return=representation')
    check(f'[{t}] Supervisor corrects a pipe record of their organization and is stamped as editor',
          status == 200 and isinstance(body, list) and len(body) == 1
          and body[0].get('formation') == 'Weathered Basalt' and body[0].get('edited_by') == s.id,
          f'HTTP {status} {short(body)}')
    status, body = rest('PATCH', f'/boreholes?id=eq.{org.rows["boreholes"]}', s,
                        {'client': 'changed by a reviewer'}, prefer='return=representation')
    check(f'[{t}] Supervisor cannot change a borehole they did not author (only pipe corrections)',
          no_effect(status, body), f'HTTP {status} {short(body)}')

    # --- Administrator: reads the organization, never inserts, corrects a pipe ---
    for table in TABLES:
        status, body = rest('GET', f'/{table}?id=eq.{org.rows[table]}&select=id', a)
        check(f'[{t}] Administrator reads the Driller\'s row in {table}',
              status == 200 and body == [{'id': org.rows[table]}], f'HTTP {status} {short(body)}')
        bh = org.rows['boreholes'] if table != 'boreholes' else None
        rid, status, body, row = create(table, a, borehole=bh, org=org.id, mark='by an administrator')
        check(f'[{t}] Administrator cannot insert into {table} of their own organization',
              not good(status), f'HTTP {status} {short(body)}')
    status, body = rest('PATCH', f'/pipe_records?id=eq.{org.pipe2}', a,
                        {'bit_type': 'Tricone Roller Bit'}, prefer='return=representation')
    check(f'[{t}] Administrator corrects a pipe record of their organization',
          status == 200 and isinstance(body, list) and len(body) == 1
          and body[0].get('bit_type') == 'Tricone Roller Bit' and body[0].get('edited_by') == a.id,
          f'HTTP {status} {short(body)}')
    status, body = rest('PATCH', f'/boreholes?id=eq.{org.rows["boreholes"]}', a,
                        {'client': 'changed by an administrator'}, prefer='return=representation')
    check(f'[{t}] Administrator cannot change a borehole', no_effect(status, body),
          f'HTTP {status} {short(body)}')

    # --- a non-reviewer of the same organization does not see another author's rows ---
    if outsider is not None:
        rid, status, body, row = create('boreholes', outsider, mark='by the data logger')
        check(f'[{t}] Data Logger creates a borehole (without org_id) in their organization',
              good(status) and row is not None and row.get('org_id') == org.id,
              f'HTTP {status} {short(body)}')
        prid, status, body, row = create('pipe_records', outsider, borehole=rid, mark='by the data logger')
        check(f'[{t}] Data Logger logs a pipe record', good(status), f'HTTP {status} {short(body)}')
        for table in TABLES:
            status, body = rest('GET', f'/{table}?id=eq.{org.rows[table]}&select=id', outsider)
            check(f'[{t}] a Data Logger of the same organization does not read the Driller\'s row'
                  f' in {table} (author or reviewer only)', status == 200 and body == [],
                  f'HTTP {status} {short(body)}')


# --------------------------------------------------------------------------
# 3. criterion 12 on the record tables
# --------------------------------------------------------------------------

def attack(att, role, A, B, writer):
    """`att`, a member of A with `role`, goes after B's rows in every table by
    every route. `writer` says whether the role may insert in A at all."""
    tag = f'[{A.tag} -> {B.tag}] {role}'
    leaks = []
    absent = []       # (what, id) that must not exist afterwards
    forged = []       # (table, id) inserted on A's borehole while naming B: must be A's
    own = {}          # table -> id of a row of A authored by `att`
    http = {}

    def go(method, path, body=None, prefer=None):
        status, answer = rest(method, path, att, body, prefer)
        found = leaked(answer, B.secrets())
        if found:
            leaks.append(f'{method} {path.split("?")[0]}')
        return status, answer

    # the attacker's own borehole in A (writers only)
    if writer:
        own_bh, status, body, row = create('boreholes', att, org=A.id, mark=f'own of {role}')
        check(f'{tag} creates a borehole in their own organization',
              good(status) and row is not None and row.get('org_id') == A.id,
              f'HTTP {status} {short(body)}')
        own['boreholes'] = own_bh
    else:
        own_bh = A.spare['boreholes']

    for table in TABLES:
        victim = B.rows[table]
        is_child = table != 'boreholes'
        t = f'{tag} / {table}:'

        # listing
        status, body = go('GET', f'/{table}?select=*')
        rows = body if isinstance(body, list) else None
        check(f'{t} a listing holds no row of the other organization',
              status == 200 and rows is not None
              and all(r.get('org_id') != B.id for r in rows) and all(r.get('id') != victim for r in rows),
              f'HTTP {status}, {len(rows) if rows is not None else "?"} row(s)')
        # direct id
        status, body = go('GET', f'/{table}?id=eq.{victim}&select=*')
        check(f'{t} cannot read the other organization\'s row by its id',
              status == 200 and body == [], f'HTTP {status} {short(body)}')
        # asking for the other organization by its id
        status, body = go('GET', f'/{table}?org_id=eq.{B.id}&select=*')
        check(f'{t} filtering on the other organization\'s org_id returns nothing',
              status == 200 and body == [], f'HTTP {status} {short(body)}')

        # insert, sending the other organization's org_id
        rid = new_id()
        if not is_child:
            status, body = go('POST', f'/{table}', record(table, rid, att, org=B.id, mark='forged org'),
                              prefer='return=representation')
            check(f'{t} cannot create a row by sending the other organization\'s org_id (42501)',
                  not good(status) and code(body) == '42501', f'HTTP {status} {short(body)}')
            absent.append((f'{t} the row sent with the other organization\'s org_id', rid))
        else:
            status, body = go('POST', f'/{table}',
                              record(table, rid, att, borehole=own_bh, org=B.id, mark='forged org'),
                              prefer='return=representation')
            if writer:
                check(f'{t} a child sent with the other organization\'s org_id on an own borehole'
                      ' is stored under the borehole\'s organization, not the one sent',
                      good(status) and isinstance(body, list) and len(body) == 1
                      and body[0].get('org_id') == A.id, f'HTTP {status} {short(body)}')
                forged.append((table, rid))
                own[table] = rid
            else:
                check(f'{t} cannot insert a child while naming the other organization',
                      not good(status), f'HTTP {status} {short(body)}')
                absent.append((f'{t} the child sent with the other organization\'s org_id', rid))

            # attach a child to the other organization's borehole
            for sent_org, how in ((None, 'without org_id'), (A.id, 'naming their own organization'),
                                  (B.id, 'naming the other organization')):
                rid = new_id()
                status, body = go('POST', f'/{table}',
                                  record(table, rid, att, borehole=B.rows['boreholes'], org=sent_org,
                                         mark='attached'), prefer='return=representation')
                check(f'{t} cannot attach a child to the other organization\'s borehole ({how})',
                      not good(status), f'HTTP {status} {short(body)}')
                absent.append((f'{t} the child attached to the other organization\'s borehole ({how})',
                               rid))

        # update
        status, body = go('PATCH', f'/{table}?id=eq.{victim}', {MARK[table]: 'HIJACKED'},
                          prefer='return=representation')
        http['update'] = no_effect(status, body)
        check(f'{t} an update of the other organization\'s row touches nothing',
              no_effect(status, body), f'HTTP {status} {short(body)}')
        # update addressed through the organization id instead of the row id
        status, body = go('PATCH', f'/{table}?org_id=eq.{B.id}', {MARK[table]: 'HIJACKED'},
                          prefer='return=representation')
        check(f'{t} an update addressed to every row of the other organization touches nothing',
              no_effect(status, body), f'HTTP {status} {short(body)}')
        # soft delete
        status, body = go('PATCH', f'/{table}?id=eq.{victim}', {'deleted_at': LATER},
                          prefer='return=representation')
        check(f'{t} a soft delete of the other organization\'s row touches nothing',
              no_effect(status, body), f'HTTP {status} {short(body)}')
        # hard delete
        status, body = go('DELETE', f'/{table}?id=eq.{victim}', prefer='return=representation')
        check(f'{t} a DELETE of the other organization\'s row removes nothing',
              no_effect(status, body), f'HTTP {status} {short(body)}')
        # upsert onto the foreign id
        for sent_org, how in ((A.id, 'naming their own organization'),
                              (B.id, 'naming the other organization')):
            row = record(table, victim, att, borehole=own_bh if is_child else None, org=sent_org,
                         mark='UPSERTED')
            status, body = go('POST', f'/{table}', row,
                              prefer='resolution=merge-duplicates,return=representation')
            check(f'{t} an upsert onto the other organization\'s id is refused ({how})',
                  not good(status), f'HTTP {status} {short(body)}')
        if is_child:
            row = record(table, victim, att, borehole=B.rows['boreholes'], mark='UPSERTED')
            status, body = go('POST', f'/{table}', row,
                              prefer='resolution=merge-duplicates,return=representation')
            check(f'{t} an upsert onto the other organization\'s id, on its own borehole, is refused',
                  not good(status), f'HTTP {status} {short(body)}')

        # move a row of one's own organization into the other one
        mine = own.get(table) or A.spare[table]
        status, body = go('PATCH', f'/{table}?id=eq.{mine}', {'org_id': B.id},
                          prefer='return=representation')
        if table in own:
            check(f'{t} cannot move their own row to the other organization (org_id is immutable, 42501)',
                  not good(status) and code(body) == '42501', f'HTTP {status} {short(body)}')
        else:
            check(f'{t} cannot move a row of their organization to the other one',
                  no_effect(status, body), f'HTTP {status} {short(body)}')
        if is_child:
            status, body = go('PATCH', f'/{table}?id=eq.{mine}', {'borehole_id': B.rows['boreholes']},
                              prefer='return=representation')
            http[f'rehang {table}'] = (status, short(body, 90))

    # ---- the truth, from the database ----
    wanted = list(B.rows.values()) + [rid for _, rid in absent] + [rid for _, rid in forged] \
        + list(own.values()) + list(A.spare.values())
    state = fx.record_state(wanted)
    for table in TABLES:
        victim = B.rows[table]
        now = state.get(victim, {}).get('row')
        check(f'{tag} / {table}: the other organization\'s row is identical in the database after'
              ' every attempt (update, soft delete, delete, upsert)', now == B.baseline[victim],
              '' if now == B.baseline[victim] else short(
                  {k: (B.baseline[victim].get(k), (now or {}).get(k)) for k in B.baseline[victim]
                   if (now or {}).get(k) != B.baseline[victim].get(k)}))
    stored = [what for what, rid in absent if rid in state]
    check(f'{tag}: none of the refused rows exists in the database', not stored, '; '.join(stored)[:300])
    wrong = [f'{table} {state.get(rid, {}).get("row", {}).get("org_id")}' for table, rid in forged
             if state.get(rid, {}).get('row', {}).get('org_id') != A.id]
    if forged:
        check(f'{tag}: every child sent with the other organization\'s org_id is stored under'
              ' their own organization', not wrong, '; '.join(wrong))
    moved = [rid for rid in list(own.values()) + list(A.spare.values())
             if state.get(rid, {}).get('row', {}).get('org_id') != A.id]
    check(f'{tag}: no row of their organization moved to the other one', not moved, str(moved))
    rehung = [f'{state[rid]["table"]} {http.get("rehang " + state[rid]["table"])}'
              for rid in set(list(own.values()) + list(A.spare.values()))
              if state.get(rid, {}).get('row', {}).get('borehole_id') == B.rows['boreholes']]
    check(f'{tag}: no child of their organization ends up attached to the other organization\'s'
          ' borehole', not rehung, '; '.join(rehung))
    check(f'{tag}: no response carried data of the other organization', not leaks,
          ', '.join(sorted(set(leaks))))


def records_isolation():
    section('3. criterion 12 on the four record tables, both directions, every verb')
    for org in (F, S):
        state = fx.record_state(org.rows.values())
        org.baseline = {rid: entry['row'] for rid, entry in state.items()}
        check(f'[{org.tag}] the four victim rows exist, in the right organization',
              len(org.baseline) == 4 and all(r['org_id'] == org.id for r in org.baseline.values())
              and all(r[MARK[TABLES[i]]] == org.secret[TABLES[i]]
                      for i, r in enumerate(org.baseline[org.rows[t]] for t in TABLES)))

    for A, B in ((F, S), (S, F)):
        attack(A.driller, 'Driller', A, B, writer=True)
        attack(A.supervisor, 'Supervisor', A, B, writer=True)
        attack(A.admin, 'Administrator', A, B, writer=False)
    attack(fx['fl'], 'Data Logger', F, S, writer=True)

    # in-organization reviewers see all of their own and none of the other
    for A, B in ((F, S), (S, F)):
        for who, role in ((A.supervisor, 'Supervisor'), (A.admin, 'Administrator')):
            for table in TABLES:
                status, body = rest('GET', f'/{table}?select=id,org_id', who)
                ids = {r['id'] for r in body} if isinstance(body, list) else set()
                orgs = {r['org_id'] for r in body} if isinstance(body, list) else {'?'}
                check(f'[{A.tag}] {role} sees all of their organization\'s {table} and none of the'
                      ' other\'s', status == 200 and A.rows[table] in ids and orgs == {A.id},
                      f'HTTP {status}, {len(ids)} row(s), {len(orgs)} organization(s)')

    # not signed in
    for table in TABLES:
        status, body = rest('GET', f'/{table}?select=id', None)
        check(f'a request that is not signed in reads nothing from {table}',
              not good(status) or body == [], f'HTTP {status} {short(body)}')
    rid = new_id()
    status, body = rest('POST', '/boreholes', None,
                        {'id': rid, 'name': 'anonymous', 'created_by': S.driller.id,
                         'recorded_at': TS, 'org_id': S.id}, prefer='return=representation')
    check('a request that is not signed in cannot create a borehole', not good(status),
          f'HTTP {status} {short(body)}')


# --------------------------------------------------------------------------
# 4. the member of both organizations
# --------------------------------------------------------------------------

def dual_member():
    section('4. the member of both organizations (Driller in F, Supervisor in S)')
    dual = fx['dual']

    status, body = rpc('my_organizations', dual)
    got = sorted((r.get('org_id'), r.get('role'), r.get('status')) for r in body) \
        if isinstance(body, list) else None
    check('my_organizations() reports both memberships, each with its own role',
          got == sorted([(F.id, 'Driller', 'active'), (S.id, 'Supervisor', 'active')]),
          f'HTTP {status} {short(body)}')

    rid, status, body, row = create('boreholes', dual, mark='dual without org')
    check('a borehole sent without org_id by a member of two organizations is rejected (42501)',
          not good(status) and code(body) == '42501', f'HTTP {status} {short(body)}')
    no_org = rid

    bh = {}
    for org in (F, S):
        rid, status, body, row = create('boreholes', dual, org=org.id, mark=f'dual in {org.tag}')
        bh[org.tag] = rid
        check(f'the member of both creates a borehole in {org.tag} by naming it',
              good(status) and row is not None and row.get('org_id') == org.id,
              f'HTTP {status} {short(body)}')
    kids = {}
    for org, other in ((F, S), (S, F)):
        for table in CHILDREN:
            rid, status, body, row = create(table, dual, borehole=bh[org.tag], org=other.id,
                                            mark=f'dual child in {org.tag}')
            kids[(org.tag, table)] = rid
            check(f'a {table} row on their {org.tag} borehole is stored in {org.tag} even when sent'
                  f' with {other.tag}\'s org_id', good(status) and row is not None
                  and row.get('org_id') == org.id, f'HTTP {status} {short(body)}')

    status, body = rest('PATCH', f'/boreholes?id=eq.{bh["F"]}', dual, {'org_id': S.id},
                        prefer='return=representation')
    check('the member of both cannot move their own borehole from one organization to the other'
          ' (42501)', not good(status) and code(body) == '42501', f'HTTP {status} {short(body)}')
    status, body = rest('PATCH', f'/boreholes?id=eq.{bh["F"]}', dual, {'org_id': F.id, 'client': 'same org'},
                        prefer='return=representation')
    check('re-sending the same org_id in an update is not a change',
          status == 200 and isinstance(body, list) and len(body) == 1
          and body[0].get('client') == 'same org', f'HTTP {status} {short(body)}')
    for table in CHILDREN:
        rid = kids[('F', table)]
        status, body = rest('PATCH', f'/{table}?id=eq.{rid}', dual, {'org_id': S.id},
                            prefer='return=representation')
        check(f'the member of both cannot move their own {table} row to the other organization (42501)',
              not good(status) and code(body) == '42501', f'HTTP {status} {short(body)}')
        rest('PATCH', f'/{table}?id=eq.{rid}', dual, {'borehole_id': bh['S']},
             prefer='return=representation')

    state = fx.record_state([no_org] + list(bh.values()) + list(kids.values()))
    check('the borehole sent without org_id was not stored', no_org not in state)
    check('each of their rows is in the organization of its borehole, in the database',
          all(state.get(bh[tag], {}).get('row', {}).get('org_id') == org.id
              for tag, org in (('F', F), ('S', S)))
          and all(state.get(rid, {}).get('row', {}).get('org_id') == (F.id if tag == 'F' else S.id)
                  for (tag, _), rid in kids.items()))
    crossed = [f'{table}' for (tag, table), rid in kids.items()
               if state.get(rid, {}).get('row', {}).get('borehole_id') != bh[tag]]
    check('a child row cannot be re-attached to a borehole of the other organization, even by a'
          ' member of both', not crossed, ', '.join(crossed))

    # each organization's data only under that organization's id
    for table in TABLES:
        status, body = rest('GET', f'/{table}?org_id=eq.{F.id}&select=id,org_id,created_by', dual)
        rows = body if isinstance(body, list) else []
        check(f'under F\'s id the member of both (a Driller there) sees only their own {table},'
              ' all of them F\'s', status == 200
              and all(r['org_id'] == F.id and r['created_by'] == dual.id for r in rows)
              and F.rows[table] not in {r['id'] for r in rows}, f'HTTP {status}, {len(rows)} row(s)')
        status, body = rest('GET', f'/{table}?org_id=eq.{S.id}&select=id,org_id', dual)
        rows = body if isinstance(body, list) else []
        check(f'under S\'s id the member of both (a Supervisor there) sees S\'s {table}, and only S\'s',
              status == 200 and S.rows[table] in {r['id'] for r in rows}
              and all(r['org_id'] == S.id for r in rows), f'HTTP {status}, {len(rows)} row(s)')
        status, body = rest('GET', f'/{table}?id=eq.{F.rows[table]}&select=id', dual)
        check(f'being a Supervisor in S gives no reviewer access to F\'s {table}',
              status == 200 and body == [], f'HTTP {status} {short(body)}')

    status, body = rest('PATCH', f'/pipe_records?id=eq.{F.pipe2}', dual, {'formation': 'By S reviewer'},
                        prefer='return=representation')
    check('being a Supervisor in S does not let them correct a pipe record of F',
          no_effect(status, body), f'HTTP {status} {short(body)}')
    status, body = rest('PATCH', f'/pipe_records?id=eq.{S.pipe2}', dual, {'formation': 'Dual corrected'},
                        prefer='return=representation')
    check('as a Supervisor in S they correct a pipe record of S',
          status == 200 and isinstance(body, list) and len(body) == 1
          and body[0].get('formation') == 'Dual corrected', f'HTTP {status} {short(body)}')

    # what each organization's reviewers see of the member of both
    for org, other in ((F, S), (S, F)):
        for who, role in ((org.supervisor, 'Supervisor'), (org.admin, 'Administrator')):
            a = rest('GET', f'/boreholes?id=eq.{bh[org.tag]}&select=id', who)[1]
            b = rest('GET', f'/boreholes?id=eq.{bh[other.tag]}&select=id', who)[1]
            check(f'[{org.tag}] {role} sees the shared member\'s borehole in {org.tag} and not the'
                  f' one in {other.tag}', a == [{'id': bh[org.tag]}] and b == [], f'{short(a)} / {short(b)}')

    status, body = rest('GET', '/memberships?select=org_id,user_id', dual)
    rows = body if isinstance(body, list) else []
    check('the member of both reads their own two membership rows and nobody else\'s (not an'
          ' Administrator anywhere)', status == 200 and len(rows) == 2
          and {r['org_id'] for r in rows} == {F.id, S.id} and {r['user_id'] for r in rows} == {dual.id},
          f'HTTP {status}, {len(rows)} row(s)')
    status, body = rest('GET', '/organizations?select=id', dual)
    check('the member of both reads both organizations', status == 200 and isinstance(body, list)
          and {r['id'] for r in body} == {F.id, S.id}, f'HTTP {status} {short(body)}')
    return bh


# --------------------------------------------------------------------------
# 5. profiles
# --------------------------------------------------------------------------

def profiles():
    section('5. profiles')
    dual = fx['dual']
    f_only = [fx[x] for x in ('fa', 'fs', 'fd', 'fl', 'fx', 'fxd', 'fv', 'fp', 'fh')]
    s_only = [fx[x] for x in ('sa', 'ss', 'sd', 'sx')]
    before = fx.account_state([a.id for a in fx.accounts.values()])

    for A, mine, theirs in ((F, f_only, s_only), (S, s_only, f_only)):
        for who, role in ((A.driller, 'Driller'), (A.supervisor, 'Supervisor'), (A.admin, 'Administrator')):
            status, body = rest('GET', '/profiles?select=id', who)
            ids = {r['id'] for r in body} if isinstance(body, list) else None
            check(f'[{A.tag}] {role}: a listing of profiles holds nobody who is only in the other'
                  ' organization', status == 200 and ids is not None
                  and not ids & {a.id for a in theirs}, f'HTTP {status}, {len(ids or [])} profile(s)')
            target = theirs[0]
            status, body = rest('GET', f'/profiles?id=eq.{target.id}&select=*', who)
            check(f'[{A.tag}] {role}: cannot read a profile of the other organization by its id',
                  status == 200 and body == [], f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/profiles?id=eq.{target.id}', who,
                                {'name': 'HIJACKED', 'badge_number': 'HIJACKED'},
                                prefer='return=representation')
            check(f'[{A.tag}] {role}: an update of a profile of the other organization touches nothing',
                  no_effect(status, body), f'HTTP {status} {short(body)}')
            status, body = rest('DELETE', f'/profiles?id=eq.{target.id}', who,
                                prefer='return=representation')
            check(f'[{A.tag}] {role}: cannot delete a profile of the other organization',
                  no_effect(status, body), f'HTTP {status} {short(body)}')
            wanted_role = 'Supervisor' if role == 'Administrator' else 'Administrator'
            status, body = rest('PATCH', f'/profiles?id=eq.{who.id}', who, {'role': wanted_role},
                                prefer='return=representation')
            check(f'[{A.tag}] {role}: cannot set their own profiles.role',
                  not good(status) or not body or body[0].get('role') == role,
                  f'HTTP {status} {short(body)}')
            status, body = rest('GET', f'/profiles?id=eq.{who.id}&select=id', who)
            check(f'[{A.tag}] {role}: reads their own profile', body == [{'id': who.id}],
                  f'HTTP {status} {short(body)}')

        # reviewers read the profiles of their organization; a Driller does not
        ids_mine = {a.id for a in mine} | {dual.id}
        for who, role in ((A.supervisor, 'Supervisor'), (A.admin, 'Administrator')):
            status, body = rest('GET', '/profiles?select=id', who)
            ids = {r['id'] for r in body} if isinstance(body, list) else set()
            check(f'[{A.tag}] {role}: reads the profile of every member of their organization,'
                  ' the shared member included', ids_mine <= ids,
                  f'{len(ids_mine - ids)} missing of {len(ids_mine)}')
        status, body = rest('GET', f'/profiles?id=eq.{A.supervisor.id}&select=id', A.driller)
        check(f'[{A.tag}] Driller: does not read a colleague\'s profile (own row only)',
              status == 200 and body == [], f'HTTP {status} {short(body)}')

    # the shared member's profile is one row, visible from both sides, changeable from neither
    for who, where in ((F.admin, 'F'), (S.admin, 'S')):
        status, body = rest('PATCH', f'/profiles?id=eq.{dual.id}', who, {'role': 'Administrator'},
                            prefer='return=representation')
        check(f'[{where}] Administrator: cannot change the shared member\'s profiles.role through'
              ' the API', no_effect(status, body), f'HTTP {status} {short(body)}')
    rid = str(uuid.uuid4())
    status, body = rest('POST', '/profiles', F.admin, {'id': rid, 'name': 'made up', 'role': 'Administrator'},
                        prefer='return=representation')
    check('nobody inserts a profile through the API', not good(status), f'HTTP {status} {short(body)}')
    status, body = rest('GET', '/profiles?select=id', None)
    check('a request that is not signed in reads no profile', not good(status) or body == [],
          f'HTTP {status} {short(body)}')

    after = fx.account_state([a.id for a in fx.accounts.values()])
    changed = [a.label for a in fx.accounts.values() if after.get(a.id) != before.get(a.id)]
    check('no profile, membership or account changed in the database through any of these attempts',
          not changed, ', '.join(changed))


# --------------------------------------------------------------------------
# 6. memberships, organizations, helper functions
# --------------------------------------------------------------------------

def memberships_and_organizations():
    section('6. memberships, organizations and the helper functions')
    dual = fx['dual']
    members_before = fx.all_memberships()
    orgs_before = fx.organizations()
    in_org = {F.id: {m['user_id'] for m in members_before if m['org_id'] == F.id},
              S.id: {m['user_id'] for m in members_before if m['org_id'] == S.id}}
    new_orgs = []

    for A, B in ((F, S), (S, F)):
        t = A.tag
        # --- reading memberships ---
        status, body = rest('GET', '/memberships?select=org_id,user_id', A.admin)
        rows = body if isinstance(body, list) else []
        check(f'[{t}] Administrator reads every membership of their organization and none of the other',
              status == 200 and {r['org_id'] for r in rows} == {A.id}
              and {r['user_id'] for r in rows} == in_org[A.id], f'HTTP {status}, {len(rows)} row(s)')
        for who, role in ((A.driller, 'Driller'), (A.supervisor, 'Supervisor')):
            status, body = rest('GET', '/memberships?select=org_id,user_id', who)
            check(f'[{t}] {role} reads only their own membership row',
                  status == 200 and body == [{'org_id': A.id, 'user_id': who.id}],
                  f'HTTP {status}, {len(body) if isinstance(body, list) else "?"} row(s)')
        for who, role in ((A.driller, 'Driller'), (A.supervisor, 'Supervisor'), (A.admin, 'Administrator')):
            status, body = rest('GET', f'/memberships?org_id=eq.{B.id}&select=*', who)
            check(f'[{t}] {role}: asking for the other organization\'s memberships returns nothing',
                  status == 200 and body == [], f'HTTP {status} {short(body)}')
            status, body = rest('GET', f'/memberships?user_id=eq.{B.driller.id}&select=*', who)
            check(f'[{t}] {role}: cannot read a membership of the other organization by user id',
                  status == 200 and body == [], f'HTTP {status} {short(body)}')

            # --- writing memberships ---
            status, body = rest('POST', '/memberships', who,
                                {'org_id': B.id, 'user_id': who.id, 'role': 'Administrator',
                                 'status': 'active'}, prefer='return=representation')
            check(f'[{t}] {role}: cannot give themselves a membership in the other organization',
                  not good(status), f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/memberships?org_id=eq.{B.id}', who,
                                {'status': 'deactivated'}, prefer='return=representation')
            check(f'[{t}] {role}: cannot deactivate the other organization\'s members',
                  no_effect(status, body), f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/memberships?user_id=eq.{B.driller.id}', who,
                                {'role': 'Administrator', 'org_id': A.id}, prefer='return=representation')
            check(f'[{t}] {role}: cannot change or move a membership of the other organization',
                  no_effect(status, body), f'HTTP {status} {short(body)}')
            status, body = rest('DELETE', f'/memberships?org_id=eq.{B.id}', who,
                                prefer='return=representation')
            check(f'[{t}] {role}: cannot delete the other organization\'s memberships',
                  no_effect(status, body), f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/memberships?user_id=eq.{who.id}', who,
                                {'role': 'Administrator', 'badge_number': 'SELF'},
                                prefer='return=representation')
            check(f'[{t}] {role}: cannot edit their own membership through the API',
                  no_effect(status, body), f'HTTP {status} {short(body)}')

            # --- organizations ---
            status, body = rest('GET', '/organizations?select=id', who)
            check(f'[{t}] {role} reads their own organization and no other',
                  status == 200 and body == [{'id': A.id}], f'HTTP {status} {short(body)}')
            status, body = rest('GET', f'/organizations?id=eq.{B.id}&select=*', who)
            check(f'[{t}] {role}: cannot read the other organization by its id',
                  status == 200 and body == [], f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/organizations?id=eq.{B.id}', who, {'name': 'HIJACKED'},
                                prefer='return=representation')
            check(f'[{t}] {role}: cannot rename the other organization', no_effect(status, body),
                  f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/organizations?id=eq.{A.id}', who,
                                {'name': 'RENAMED', 'is_founding': A is not F},
                                prefer='return=representation')
            check(f'[{t}] {role}: cannot change their own organization through the API either',
                  no_effect(status, body), f'HTTP {status} {short(body)}')
            status, body = rest('DELETE', f'/organizations?id=eq.{B.id}', who,
                                prefer='return=representation')
            check(f'[{t}] {role}: cannot delete the other organization', no_effect(status, body),
                  f'HTTP {status} {short(body)}')
            oid = str(uuid.uuid4())
            new_orgs.append(oid)
            status, body = rest('POST', '/organizations', who, {'id': oid, 'name': f'TISO made up {RUN}'},
                                prefer='return=representation')
            check(f'[{t}] {role}: cannot create an organization', not good(status),
                  f'HTTP {status} {short(body)}')

            # --- helper functions ---
            status, body = rpc('my_organizations', who)
            check(f'[{t}] {role}: my_organizations() reports their one membership',
                  status == 200 and isinstance(body, list) and len(body) == 1
                  and body[0].get('org_id') == A.id and body[0].get('role') == role
                  and body[0].get('status') == 'active', f'HTTP {status} {short(body)}')
            status, body = rpc('is_org_member', who, {'org': B.id})
            check(f'[{t}] {role}: is_org_member() of the other organization is false', body is False,
                  f'HTTP {status} {short(body)}')
            status, body = rpc('is_org_admin', who, {'org': B.id})
            check(f'[{t}] {role}: is_org_admin() of the other organization is false', body is False,
                  f'HTTP {status} {short(body)}')
            status, body = rest('POST', '/platform_admins', who, {'user_id': who.id},
                                prefer='return=representation')
            status2, body2 = rpc('is_platform_admin', who)
            check(f'[{t}] {role}: cannot make themselves a platform administrator',
                  not good(status) and body2 is False, f'HTTP {status} {short(body)} / {short(body2)}')

    for name, args in (('my_organizations', {}), ('is_org_member', {'org': S.id}),
                       ('is_org_admin', {'org': S.id}), ('is_platform_admin', {})):
        status, body = rpc(name, None, args)
        check(f'a request that is not signed in may not execute {name}()', not good(status),
              f'HTTP {status} {short(body)}')
    for table in ('memberships', 'organizations', 'platform_admins', 'audit_log'):
        status, body = rest('GET', f'/{table}?select=*', None)
        check(f'a request that is not signed in reads nothing from {table}',
              not good(status) or body == [], f'HTTP {status} {short(body)}')
    for who, where in ((F.admin, 'F'), (S.admin, 'S')):
        for table in ('platform_admins', 'audit_log'):
            status, body = rest('GET', f'/{table}?select=*', who)
            check(f'[{where}] Administrator reads nothing from {table} that is not theirs',
                  status == 200 and isinstance(body, list)
                  and all(r.get('org_id') == (F.id if where == 'F' else S.id) for r in body)
                  and (table != 'platform_admins' or body == []), f'HTTP {status} {short(body)}')

    check('the memberships table is identical in the database after every attempt',
          fx.all_memberships() == members_before)
    orgs_after = fx.organizations()
    check('the organizations table is identical in the database after every attempt',
          orgs_after == orgs_before, short(orgs_after))
    del dual, new_orgs


# --------------------------------------------------------------------------
# 7. photos
# --------------------------------------------------------------------------

photos = {}   # label -> (path, bytes)


def put(label, account, path, expect=True, why=''):
    data = photo_bytes(label)
    status, body = upload(account, path, data)
    if expect:
        if check(f'{why}', good(status), f'HTTP {status} {short(body)}'):
            photos[label] = (path, data)
    else:
        check(f'{why}', not good(status), f'HTTP {status} {short(body)}')
    return path


def cannot_touch(att, who, label, move_to, copy_to):
    """`att` tries every route to the stored photo `label`; `move_to` and
    `copy_to` are folders `att` may write to. Returns the paths a successful
    move or copy would have created."""
    path, data = photos[label]
    name = f'{who} / {label}:'
    status, raw = download(att, path)
    check(f'{name} cannot download it', status != 200 and data not in raw, f'HTTP {status}')
    status, content = signed_content(att, path)
    check(f'{name} cannot mint a signed URL for it', not good(status) and content is None,
          f'HTTP {status}')
    folder = path.rsplit('/', 1)[0]
    names = listing(att, folder)
    check(f'{name} a listing of its folder shows nothing', names == [], short(names))
    status, body = upload(att, path, photo_bytes('overwrite'), upsert=True)
    check(f'{name} cannot overwrite it (upsert)', not good(status), f'HTTP {status} {short(body)}')
    status, body = upload(att, path, photo_bytes('overwrite'), method='PUT')
    check(f'{name} cannot replace it (PUT)', not good(status), f'HTTP {status} {short(body)}')
    status, body = storage_delete(att, path)
    moved = f'{move_to}/{RUN}-moved-{uuid.uuid4().hex[:8]}.jpg'
    copied = f'{copy_to}/{RUN}-copied-{uuid.uuid4().hex[:8]}.jpg'
    s_move, b_move = storage_post(att, 'move', {'bucketId': BUCKET, 'sourceKey': path,
                                                'destinationKey': moved})
    s_copy, b_copy = storage_post(att, 'copy', {'bucketId': BUCKET, 'sourceKey': path,
                                                'destinationKey': copied})
    check(f'{name} cannot move or copy it into a folder of their own',
          not good(s_move) and not good(s_copy), f'move HTTP {s_move}, copy HTTP {s_copy}')
    return [moved, copied]


def photos_section(dual_bh):
    section('7. photos: new path <org>/<user>/<file> and legacy path <user>/<file>')
    fa, fs, fd, fl = fx['fa'], fx['fs'], fx['fd'], fx['fl']
    sa, ss, sd = fx['sa'], fx['ss'], fx['sd']
    dual, fx_, fxd, sx = fx['dual'], fx['fx'], fx['fxd'], fx['sx']
    f, s = F.id, S.id
    n = f'{RUN}.jpg'

    # --- every active member uploads under <org>/<own id>/ (criterion 20) ---
    for label, who, org, role in (('F new, Driller', fd, f, 'F Driller'), ('F new, Supervisor', fs, f, 'F Supervisor'),
                                  ('F new, Administrator', fa, f, 'F Administrator'),
                                  ('F new, Data Logger', fl, f, 'F Data Logger'),
                                  ('S new, Driller', sd, s, 'S Driller'), ('S new, Supervisor', ss, s, 'S Supervisor'),
                                  ('S new, Administrator', sa, s, 'S Administrator'),
                                  ('F new, shared member', dual, f, 'shared member in F'),
                                  ('S new, shared member', dual, s, 'shared member in S'),
                                  ('F new, admin to be deactivated', fx_, f, 'F Administrator (later deactivated)'),
                                  ('F new, driller to be deactivated', fxd, f, 'F Driller (later deactivated)'),
                                  ('S new, supervisor to be deactivated', sx, s, 'S Supervisor (later deactivated)')):
        put(label, who, f'{org}/{who.id}/{n}', True,
            f'{role} uploads under <their organization>/<own id>/')
    # --- legacy path: founding members only (criteria 30, 43) ---
    for label, who, role in (('F legacy, Driller', fd, 'F Driller'), ('F legacy, Administrator', fa, 'F Administrator'),
                             ('F legacy, shared member', dual, 'shared member (a founding member)'),
                             ('F legacy, admin to be deactivated', fx_, 'F Administrator (later deactivated)'),
                             ('F legacy, driller to be deactivated', fxd, 'F Driller (later deactivated)')):
        put(label, who, f'{who.id}/{n}', True, f'{role} uploads to the legacy path <own id>/')

    refused = []
    for who, role in ((sd, 'S Driller'), (ss, 'S Supervisor'), (sa, 'S Administrator')):
        refused.append(put('x', who, f'{who.id}/{RUN}-legacy.jpg', False,
                           f'{role}, not a founding member, cannot upload to the legacy path <own id>/'))
        refused.append(put('x', who, f'{f}/{who.id}/{RUN}-x.jpg', False,
                           f'{role} cannot upload under the founding organization\'s folder'))
        refused.append(put('x', who, f'{f}/{fd.id}/{RUN}-x-{who.label}.jpg', False,
                           f'{role} cannot upload into a founding member\'s folder'))
        refused.append(put('x', who, f'{fd.id}/{RUN}-x-{who.label}.jpg', False,
                           f'{role} cannot upload into a founding member\'s legacy folder'))
        refused.append(put('x', who, f'{s}/{fd.id}/{RUN}-x-{who.label}.jpg', False,
                           f'{role} cannot upload under their organization with someone else\'s id'
                           ' as the second segment'))
    for who, role in ((fd, 'F Driller'), (fs, 'F Supervisor'), (fa, 'F Administrator')):
        refused.append(put('x', who, f'{s}/{who.id}/{RUN}-x.jpg', False,
                           f'{role} cannot upload under the second organization\'s folder'))
        refused.append(put('x', who, f'{s}/{sd.id}/{RUN}-x-{who.label}.jpg', False,
                           f'{role} cannot upload into a second-organization member\'s folder'))
        refused.append(put('x', who, f'{sd.id}/{RUN}-x-{who.label}.jpg', False,
                           f'{role} cannot upload into another user\'s legacy folder'))
        refused.append(put('x', who, f'{f}/{sd.id}/{RUN}-x-{who.label}.jpg', False,
                           f'{role} cannot upload under their organization with someone else\'s id'
                           ' as the second segment'))
        refused.append(put('x', who, f'{uuid.uuid4()}/{who.id}/{RUN}-x.jpg', False,
                           f'{role} cannot upload under an organization id that does not exist'))
        refused.append(put('x', who, f'tiso-junk-{RUN}/{who.id}/x.jpg', False,
                           f'{role} cannot upload under a first segment that is neither an'
                           ' organization nor a user'))
        refused.append(put('x', who, f'tiso-junk-{RUN}-{who.label}.jpg', False,
                           f'{role} cannot upload to the top of the bucket'))

    # a legacy photo whose owner is not a founding member (stored with the service role)
    orphan = photo_bytes('orphan legacy')
    orphan_path = f'{sd.id}/{RUN}-orphan.jpg'
    fx.service_upload(orphan_path, orphan)
    photos['legacy of a non-founding member'] = (orphan_path, orphan)

    # --- who reads what, inside an organization ---
    def can(who, label, why):
        path, data = photos[label]
        check(why, reads(who, path, data))
        status, content = signed_content(who, path)
        check(why + ' (signed URL)', good(status) and content == data, f'HTTP {status}')

    def cannot(who, label, why):
        path, data = photos[label]
        status, raw = download(who, path)
        ok = status != 200 and data not in raw
        s2, content = signed_content(who, path)
        check(why, ok and content is None, f'download HTTP {status}, sign HTTP {s2}')

    # the listing probe is able to see a file where reading is allowed
    for who, label, why in (
            (fd, 'F new, Driller', 'F Driller lists their own folder on the new path and sees the photo'),
            (fd, 'F legacy, Driller', 'F Driller lists their own legacy folder and sees the photo'),
            (fa, 'F new, Driller', 'F Administrator lists a member\'s folder and sees the photo'),
            (sa, 'S new, Driller', 'S Administrator lists a member\'s folder and sees the photo')):
        folder, name = photos[label][0].rsplit('/', 1)
        names = listing(who, folder)
        check(why, name in names, short(names))
    can(fd, 'F new, Driller', 'F Driller reads their own photo on the new path')
    can(fd, 'F legacy, Driller', 'F Driller reads their own photo on the legacy path')
    can(fa, 'F new, Driller', 'F Administrator reads a member\'s photo under the organization\'s folder')
    can(fa, 'F new, Supervisor', 'F Administrator reads every path under the organization\'s folder')
    can(fa, 'F legacy, Driller', 'F Administrator reads a founding member\'s legacy photo')
    can(fa, 'F new, shared member', 'F Administrator reads the shared member\'s photo under F\'s folder')
    can(fa, 'F legacy, shared member', 'F Administrator reads the shared member\'s legacy photo')
    cannot(fs, 'F new, Driller', 'F Supervisor does not read another member\'s photo (author or Administrator only)')
    cannot(fs, 'F legacy, Driller', 'F Supervisor does not read another member\'s legacy photo')
    cannot(fl, 'F new, Driller', 'F Data Logger does not read another member\'s photo')
    can(sd, 'S new, Driller', 'S Driller reads their own photo')
    can(sa, 'S new, Driller', 'S Administrator reads a member\'s photo under the organization\'s folder')
    can(sa, 'S new, shared member', 'S Administrator reads the shared member\'s photo under S\'s folder')
    cannot(ss, 'S new, Driller', 'S Supervisor does not read another member\'s photo')
    can(dual, 'F new, shared member', 'the shared member reads their own photo under F\'s folder')
    can(dual, 'S new, shared member', 'the shared member reads their own photo under S\'s folder')
    can(dual, 'F legacy, shared member', 'the shared member reads their own legacy photo')
    cannot(dual, 'S new, Driller', 'the shared member, a Supervisor in S, does not read an S member\'s photo')
    cannot(dual, 'F new, Driller', 'the shared member, a Driller in F, does not read an F member\'s photo')

    # --- across organizations ---
    cannot(sa, 'F new, shared member',
           'S Administrator does not read the shared member\'s photo under F\'s folder')
    cannot(fa, 'S new, shared member',
           'F Administrator does not read the shared member\'s photo under S\'s folder')
    cannot(sa, 'F legacy, shared member',
           'S Administrator does not read the shared member\'s legacy photo (legacy photos are the'
           ' founding organization\'s only)')
    cannot(fa, 'legacy of a non-founding member',
           'F Administrator does not read a legacy photo whose owner is not a founding member')
    cannot(sa, 'legacy of a non-founding member',
           'S Administrator does not read a legacy photo of their own member')
    cannot(sd, 'legacy of a non-founding member',
           'a user who is not a founding member does not read a legacy photo under their own id')

    stolen = []
    for att, who in ((sd, 'S Driller'), (ss, 'S Supervisor'), (sa, 'S Administrator')):
        for label in ('F new, Driller', 'F legacy, Driller', 'F new, Administrator',
                      'F legacy, Administrator'):
            stolen += cannot_touch(att, who, label, f'{s}/{att.id}', f'{s}/{att.id}')
    for att, who in ((fd, 'F Driller'), (fs, 'F Supervisor'), (fa, 'F Administrator')):
        for label in ('S new, Driller', 'S new, Administrator', 'legacy of a non-founding member'):
            stolen += cannot_touch(att, who, label, f'{f}/{att.id}', f'{att.id}')
    for att, who, other in ((sa, 'S Administrator', f), (fa, 'F Administrator', s)):
        names = listing(att, other)
        check(f'{who}: a listing of the other organization\'s folder shows nothing', names == [],
              short(names))
        top = listing(att, '')
        check(f'{who}: a listing of the top of the bucket does not show the other organization\'s'
              ' folder', other not in top, f'{len(top)} name(s)')
    status, raw = download(None, photos['F new, Driller'][0])
    check('a request that is not signed in cannot download a photo', status != 200, f'HTTP {status}')
    status, raw = tf.request('GET', f'/storage/v1/object/public/{BUCKET}/{photos["F new, Driller"][0]}',
                             auth=False)
    check('the bucket is private: the public URL of a photo serves nothing',
          status != 200 and photos['F new, Driller'][1] not in raw, f'HTTP {status}')

    # ---- the truth, from the database ----
    state = fx.photo_state()
    expected = {path for path, _ in photos.values()}
    extra = sorted(set(state) - expected)
    missing = sorted(expected - set(state))
    check('the bucket holds exactly the photos that were allowed: no refused upload, no stolen copy,'
          ' nothing deleted', not extra and not missing,
          f'unexpected: {len(extra)} {short(extra, 200)}; missing: {len(missing)}')
    check('no refused path was stored', not (set(refused) | set(stolen)) & set(state))
    intact = [label for label, (path, data) in photos.items()
              if label.startswith(('F new, Driller', 'F legacy, Driller', 'F new, Administrator',
                                   'F legacy, Administrator', 'S new, Driller', 'S new, Administrator'))
              and not reads(fx['fa'] if label.startswith('F') else fx['sa'], path, data)]
    check('every photo that was gone after by the other organization still holds its original'
          ' content, read by its own organization\'s Administrator', not intact, ', '.join(intact))
    del dual_bh


# --------------------------------------------------------------------------
# 8. deactivated members
# --------------------------------------------------------------------------

def deactivated_members():
    section('8. deactivated members (deactivated directly; their sessions stay valid)')
    fx_, fxd, sx = fx['fx'], fx['fxd'], fx['sx']

    # what they author while active
    own = {}
    for who, org, label in ((fxd, F, 'F Driller'), (sx, S, 'S Supervisor')):
        bh, status, body, row = create('boreholes', who, org=org.id, mark=f'before deactivation {label}')
        pipe, s2, b2, r2 = create('pipe_records', who, borehole=bh, mark='before deactivation')
        own[who.label] = {'boreholes': bh, 'pipe_records': pipe}
        check(f'{label}, while active, logs a borehole and a pipe record',
              good(status) and good(s2), f'HTTP {status} / {s2}')
        status, body = rest('GET', f'/boreholes?id=eq.{bh}&select=id', who)
        check(f'{label}, while active, reads it back', body == [{'id': bh}], f'HTTP {status} {short(body)}')
    status, body = rest('GET', f'/boreholes?id=eq.{F.rows["boreholes"]}&select=id', fx_)
    check('F Administrator (to be deactivated), while active, reads the organization\'s records',
          body == [{'id': F.rows['boreholes']}], f'HTTP {status} {short(body)}')

    before_rows = fx.record_state([i for d in own.values() for i in d.values()])
    fx.set_membership_status(fxd, F.id, 'deactivated')
    fx.set_membership_status(sx, S.id, 'deactivated')
    fx.set_membership_status(fx_, F.id, 'deactivated')

    refused_ids = []
    for who, org, label, role in ((fxd, F, 'deactivated F Driller', 'Driller'),
                                  (sx, S, 'deactivated S Supervisor', 'Supervisor'),
                                  (fx_, F, 'deactivated F Administrator', 'Administrator')):
        for table in TABLES:
            status, body = rest('GET', f'/{table}?select=id', who)
            check(f'{label}: reads nothing from {table}', status == 200 and body == [],
                  f'HTTP {status}, {len(body) if isinstance(body, list) else "?"} row(s)')
        for table, rid in own.get(who.label, {}).items():
            status, body = rest('GET', f'/{table}?id=eq.{rid}&select=id', who)
            check(f'{label}: does not read their own {table} row by its id',
                  status == 200 and body == [], f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/{table}?id=eq.{rid}', who, {OTHER[table]: 'after deactivation'},
                                prefer='return=representation')
            check(f'{label}: cannot change their own {table} row', no_effect(status, body),
                  f'HTTP {status} {short(body)}')
            status, body = rest('PATCH', f'/{table}?id=eq.{rid}', who, {'deleted_at': LATER},
                                prefer='return=representation')
            check(f'{label}: cannot soft-delete their own {table} row', no_effect(status, body),
                  f'HTTP {status} {short(body)}')
        for sent, how in ((org.id, 'naming their organization'), (None, 'without org_id')):
            rid, status, body, row = create('boreholes', who, org=sent, mark='after deactivation')
            refused_ids.append(rid)
            check(f'{label}: cannot create a borehole ({how})', not good(status),
                  f'HTTP {status} {short(body)}')
        target = own.get(who.label, {}).get('boreholes') or org.rows['boreholes']
        rid, status, body, row = create('pipe_records', who, borehole=target, mark='after deactivation')
        refused_ids.append(rid)
        check(f'{label}: cannot log a pipe record', not good(status), f'HTTP {status} {short(body)}')

        status, body = rest('GET', '/memberships?select=org_id', who)
        check(f'{label}: reads no membership row, their own included', status == 200 and body == [],
              f'HTTP {status} {short(body)}')
        status, body = rest('GET', '/organizations?select=id', who)
        check(f'{label}: reads no organization row', status == 200 and body == [],
              f'HTTP {status} {short(body)}')
        status, body = rpc('my_organizations', who)
        check(f'{label}: my_organizations() still reports their row, with status deactivated',
              status == 200 and isinstance(body, list) and len(body) == 1
              and body[0].get('org_id') == org.id and body[0].get('status') == 'deactivated'
              and body[0].get('role') == role, f'HTTP {status} {short(body)}')
        status, body = rpc('is_org_member', who, {'org': org.id})
        check(f'{label}: is_org_member() of their organization is false', body is False,
              f'HTTP {status} {short(body)}')
        status, body = rest('PATCH', f'/memberships?user_id=eq.{who.id}', who, {'status': 'active'},
                            prefer='return=representation')
        check(f'{label}: cannot reactivate themselves', no_effect(status, body),
              f'HTTP {status} {short(body)}')
        status, body = rest('GET', '/profiles?select=id', who)
        ids = {r['id'] for r in body} if isinstance(body, list) else {'?'}
        check(f'{label}: reads no profile of anyone else', ids <= {who.id},
              f'HTTP {status}, {len(ids)} profile(s)')
        note(f'{label}: reading their own profile row returns {len(ids)} row(s) (the criteria do'
             ' not say either way)')

    # photos
    def unreadable(who, label, why):
        path, data = photos[label]
        status, raw = download(who, path)
        s2, content = signed_content(who, path)
        names = listing(who, path.rsplit('/', 1)[0])
        check(why, status != 200 and data not in raw and content is None and names == [],
              f'download HTTP {status}, sign HTTP {s2}, listing {len(names)}')

    unreadable(fxd, 'F new, driller to be deactivated',
               'deactivated F Driller: does not read their own photo on the new path')
    unreadable(fxd, 'F legacy, driller to be deactivated',
               'deactivated F Driller: does not read their own photo on the legacy path')
    unreadable(fx_, 'F new, admin to be deactivated',
               'deactivated F Administrator: does not read their own photo on the new path')
    unreadable(fx_, 'F legacy, admin to be deactivated',
               'deactivated F Administrator: does not read their own photo on the legacy path')
    unreadable(fx_, 'F new, Driller',
               'deactivated F Administrator: no longer reads a member\'s photo')
    unreadable(fx_, 'F legacy, Driller',
               'deactivated F Administrator: no longer reads a member\'s legacy photo')
    unreadable(sx, 'S new, supervisor to be deactivated',
               'deactivated S Supervisor: does not read their own photo')
    refused_paths = []
    for who, org, label in ((fxd, F, 'deactivated F Driller'), (fx_, F, 'deactivated F Administrator'),
                            (sx, S, 'deactivated S Supervisor')):
        path = f'{org.id}/{who.id}/{RUN}-after.jpg'
        status, body = upload(who, path, photo_bytes('after'))
        refused_paths.append(path)
        check(f'{label}: cannot upload under <organization>/<own id>/', not good(status),
              f'HTTP {status} {short(body)}')
        path = f'{who.id}/{RUN}-after.jpg'
        status, body = upload(who, path, photo_bytes('after'))
        refused_paths.append(path)
        check(f'{label}: cannot upload to the legacy path', not good(status),
              f'HTTP {status} {short(body)}')
        own_photo = [p for lbl, (p, _) in photos.items() if f'/{who.id}/' in p or p.startswith(who.id)]
        for p in own_photo:
            upload(who, p, photo_bytes('overwrite'), upsert=True)
            storage_delete(who, p)

    # criterion 19: reviewers still resolve the name on old records
    for viewer, target, why in (
            (fx['fs'], fxd, 'F Supervisor reads the profile of a deactivated member of their organization'),
            (fx['fa'], fxd, 'F Administrator reads the profile of a deactivated member of their organization'),
            (fx['ss'], sx, 'S Supervisor reads the profile of a deactivated member of their organization'),
            (fx['sa'], sx, 'S Administrator reads the profile of a deactivated member of their organization')):
        status, body = rest('GET', f'/profiles?id=eq.{target.id}&select=id,name', viewer)
        check(why, status == 200 and isinstance(body, list) and len(body) == 1
              and body[0].get('id') == target.id and bool(body[0].get('name')),
              f'HTTP {status} {short(body)}')
    for viewer, target, why in (
            (fx['fa'], sx, 'F Administrator does not read the profile of the other organization\'s'
                           ' deactivated member'),
            (fx['sa'], fxd, 'S Administrator does not read the profile of the other organization\'s'
                            ' deactivated member')):
        status, body = rest('GET', f'/profiles?id=eq.{target.id}&select=id', viewer)
        check(why, status == 200 and body == [], f'HTTP {status} {short(body)}')
    for viewer, rid, why in (
            (fx['fs'], own['fxd']['boreholes'], 'F Supervisor still reads the records a deactivated member logged'),
            (fx['sa'], own['sx']['boreholes'], 'S Administrator still reads the records a deactivated member logged')):
        status, body = rest('GET', f'/boreholes?id=eq.{rid}&select=id', viewer)
        check(why, body == [{'id': rid}], f'HTTP {status} {short(body)}')

    state = fx.record_state([i for d in own.values() for i in d.values()] + refused_ids)
    check('in the database: the deactivated members\' rows are unchanged and nothing they sent was stored',
          {k: v for k, v in state.items() if k not in refused_ids} == before_rows
          and not [i for i in refused_ids if i in state])
    pstate = fx.photo_state()
    check('in the database: the photos are exactly as before the deactivated members\' attempts',
          set(pstate) == {p for p, _ in photos.values()},
          short(sorted(set(pstate) ^ {p for p, _ in photos.values()}), 200))
    still = [label for label in ('F new, driller to be deactivated', 'F legacy, driller to be deactivated',
                                 'F new, admin to be deactivated', 'F legacy, admin to be deactivated')
             if not reads(fx['fa'], *photos[label])]
    path, data = photos['S new, supervisor to be deactivated']
    if not reads(fx['sa'], path, data):
        still.append('S new, supervisor to be deactivated')
    check('each organization\'s Administrator still reads the deactivated members\' photos, unchanged',
          not still, ', '.join(still))


# --------------------------------------------------------------------------
# 9. admin-users
# --------------------------------------------------------------------------

def admin_users():
    section('9. admin-users as deployed (criteria 32 to 36, 50)')
    fa, fs, fd, fv = fx['fa'], fx['fs'], fx['fd'], fx['fv']
    fx_, fp, fh = fx['fx'], fx['fp'], fx['fh']
    sa, sd, sx, dual = fx['sa'], fx['sd'], fx['sx'], fx['dual']
    everyone = [a.id for a in fx.accounts.values()]
    created_secret = uuid.uuid4().hex + 'Bb2'
    NOT_FOUND = {'error': 'No such account'}

    def unchanged(before, why):
        after = fx.account_state(everyone)
        changed = [a.label for a in fx.accounts.values() if after.get(a.id) != before.get(a.id)]
        check(why, not changed, 'changed: ' + ', '.join(changed) if changed else '')
        return after

    def attempts(label):
        """One request per method, each of which would change something if let in."""
        email = fx.email(f'refused-{label}')
        return email, [
            ('GET', None),
            ('POST', {'email': email, 'password': created_secret, 'name': 'TISO refused',
                      'role': 'Administrator', 'badgeNumber': 'TISO-R'}),
            ('PATCH', {'id': fv.id, 'action': 'setRole', 'role': 'Administrator'}),
            ('PATCH', {'id': fv.id, 'action': 'reactivate'}),
            ('DELETE', {'id': fv.id}),
        ]

    base = fx.account_state(everyone)

    # --- 401: no session ---
    anonymous = [
        ('no Authorization header', dict(auth=False)),
        ('a garbage token', dict(token='not-a-token-' + uuid.uuid4().hex)),
        ('a token-shaped garbage value', dict(token='aaaa.bbbb.cccc')),
        ('the publishable key as the token (no session)', dict(token=_target.KEY)),
    ]
    refused_emails = []
    for i, (how, kwargs) in enumerate(anonymous):
        email, tries = attempts(f'anon{i}')
        refused_emails.append(email)
        for method, body in tries:
            status, answer = fn(method, None, body, **kwargs)
            what = body.get('action', '') if body else ''
            check(f'{how}: {method} {what}'.rstrip() + ' is answered 401',
                  status == 401 and 'users' not in (answer if isinstance(answer, dict) else {}),
                  f'HTTP {status} {short(answer)}')
    base = unchanged(base, 'nothing changed through the requests without a session')

    # --- 403: signed in, not an active founding Administrator ---
    callers = [
        ('founding Driller', fd, 'fd'),
        ('founding Supervisor', fs, 'fs'),
        ('founding Administrator whose membership was deactivated directly', fx_, 'fx'),
        ('second organization\'s Administrator (profiles.role Administrator)', sa, 'sa'),
        ('account with profiles.role Administrator and a founding membership Driller', fp, 'fp'),
        ('second organization\'s Driller', sd, 'sd'),
        ('member of both organizations (Driller in F, Supervisor in S)', dual, 'dual'),
    ]
    for who, account, label in callers:
        email, tries = attempts(label)
        refused_emails.append(email)
        for method, body in tries:
            status, answer = fn(method, account, body)
            what = body.get('action', '') if body else ''
            check(f'{who}: {method} {what}'.rstrip() + ' is answered 403',
                  status == 403 and 'users' not in (answer if isinstance(answer, dict) else {}),
                  f'HTTP {status} {short(answer)}')
        base = unchanged(base, f'{who}: nothing changed through the refused requests')
    made_up = [e for e in refused_emails if fx.account_by_email(e)]
    check('no refused caller created an account', not made_up, ', '.join(made_up))

    # --- let in: active founding Administrator, whatever profiles.role says ---
    status, answer = fn('GET', fh)
    check('a founding Administrator whose profiles.role was set to Driller by hand is still let in',
          status == 200 and isinstance(answer, dict) and isinstance(answer.get('users'), list),
          f'HTTP {status} {short(answer)}')

    # --- the list ---
    status, answer = fn('GET', fa)
    users = answer.get('users') if isinstance(answer, dict) else None
    check('the founding Administrator gets the list', status == 200 and isinstance(users, list),
          f'HTTP {status} {short(answer)}')
    users = users or []
    by_id = {u.get('id'): u for u in users}
    members = fx.founding_members()
    check('the list holds exactly the accounts with a membership in the founding organization,'
          ' whatever its status', set(by_id) == set(members) and len(users) == len(members),
          f'{len(users)} listed, {len(members)} member(s); missing {len(set(members) - set(by_id))},'
          f' extra {len(set(by_id) - set(members))}')
    check('the list holds nobody who is only in the second organization',
          not {fx[x].id for x in ('sa', 'ss', 'sd', 'sx')} & set(by_id))
    check('the list includes members whose membership is deactivated',
          fx_.id in by_id and fx['fxd'].id in by_id)
    wrong = [u.get('email') for u in users
             if u.get('id') in members and (u.get('role') != members[u['id']]['role']
                                            or (u.get('badgeNumber') or '') != (members[u['id']]['badge_number'] or ''))]
    check('role and badge of every listed account come from its founding membership', not wrong,
          ', '.join(str(w) for w in wrong))
    check('...also where profiles.role disagrees: the hand-edited Administrator is listed as'
          ' Administrator, the founding Driller with an Administrator profile as Driller, with the'
          ' membership\'s badge',
          by_id.get(fh.id, {}).get('role') == 'Administrator' and by_id.get(fp.id, {}).get('role') == 'Driller'
          and by_id.get(fp.id, {}).get('badgeNumber') == 'TISO-FP-MEMBER',
          short({k: by_id.get(v.id, {}).get('role') for k, v in (('fh', fh), ('fp', fp))}))
    check('the shared member is listed with the founding role and badge, not the second organization\'s',
          by_id.get(dual.id, {}).get('role') == 'Driller'
          and by_id.get(dual.id, {}).get('badgeNumber') == 'TISO-DUAL-F', short(by_id.get(dual.id)))
    counts = fx.record_counts(dual)
    check('the record count shown for the shared member counts founding records only',
          counts.get(S.id, 0) > 0 and by_id.get(dual.id, {}).get('records') == counts.get(F.id, 0),
          f'listed {by_id.get(dual.id, {}).get("records")}, founding {counts.get(F.id, 0)},'
          f' second {counts.get(S.id, 0)}')
    text = json.dumps(answer)
    check('the list carries no email of a second-organization account',
          not [x for x in ('sa', 'ss', 'sd', 'sx') if fx[x].email in text])

    # --- 404: a target without a founding membership, existing or not ---
    unknown = str(uuid.uuid4())
    targets = [('a second-organization account', sd.id),
               ('a second-organization account, id in upper case', sd.id.upper()),
               ('a deactivated second-organization account', sx.id),
               ('the second organization\'s Administrator', sa.id),
               ('an unknown uuid', unknown), ('a value that is not a uuid', 'not-a-uuid'),
               ('a value shaped to break a filter', f'{sd.id},id.eq.{fv.id}'),
               ('the second organization\'s id', S.id)]
    operations = [('set-role', 'PATCH', lambda i: {'id': i, 'action': 'setRole', 'role': 'Supervisor'}),
                  ('reactivate', 'PATCH', lambda i: {'id': i, 'action': 'reactivate'}),
                  ('delete', 'DELETE', lambda i: {'id': i})]
    for op, method, make in operations:
        answers = []
        for what, target in targets:
            status, answer = fn(method, fa, make(target))
            answers.append((status, json.dumps(answer, sort_keys=True)))
            check(f'{op} against {what} is answered 404 "No such account"',
                  status == 404 and answer == NOT_FOUND, f'HTTP {status} {short(answer)}')
        check(f'{op}: the answers for an existing and a non-existing account are indistinguishable',
              len(set(answers)) == 1, short(sorted(set(answers))))
    base = unchanged(base, 'nothing changed through the requests against accounts outside the'
                           ' founding organization')
    check('the second-organization accounts still sign in',
          all(tf.sign_in(a.email, a.secret)[0] for a in (sd, sa)))

    # --- 409: a target that is also in another organization ---
    for op, method, make in operations:
        for what, target in (('the member of both organizations', dual.id),
                             ('the member of both organizations, id in upper case', dual.id.upper())):
            status, answer = fn(method, fa, make(target))
            check(f'{op} against {what} is answered 409', status == 409, f'HTTP {status} {short(answer)}')
    base = unchanged(base, 'nothing changed in either organization through the requests against the'
                           ' member of both')
    check('the member of both still signs in', bool(tf.sign_in(dual.email, dual.secret)[0]))

    # --- oneself, in any spelling ---
    for spelling, me in (('lower case', fa.id.lower()), ('upper case', fa.id.upper())):
        status, answer = fn('PATCH', fa, {'id': me, 'action': 'setRole', 'role': 'Driller'})
        check(f'changing one\'s own role is refused, own id in {spelling}', 400 <= status < 500,
              f'HTTP {status} {short(answer)}')
        status, answer = fn('DELETE', fa, {'id': me})
        check(f'removing oneself is refused, own id in {spelling}', 400 <= status < 500,
              f'HTTP {status} {short(answer)}')
    base = unchanged(base, 'the Administrator\'s own account, role and membership are unchanged'
                           ' after those requests')
    status, answer = fn('GET', fa)
    check('...and they are still let in', status == 200, f'HTTP {status}')

    # --- malformed and hostile input ---
    for what, method, body in (
            ('set-role without an id', 'PATCH', {'action': 'setRole', 'role': 'Driller'}),
            ('delete without an id', 'DELETE', {}),
            ('an unknown action', 'PATCH', {'id': fv.id, 'action': 'promote'}),
            ('set-role with a role outside the vocabulary', 'PATCH',
             {'id': fv.id, 'action': 'setRole', 'role': 'Owner'}),
            ('set-role with an empty role', 'PATCH', {'id': fv.id, 'action': 'setRole', 'role': ''})):
        status, answer = fn(method, fa, body)
        check(f'{what} is refused with a client error', 400 <= status < 500,
              f'HTTP {status} {short(answer)}')
    too_short = 'x' * 5
    bad_email = fx.email('bad-input')
    for what, body in (
            ('a role outside the vocabulary', {'email': bad_email, 'password': created_secret,
                                              'name': 'x', 'role': 'Owner'}),
            ('a password that is too short', {'email': bad_email, 'password': too_short,
                                              'name': 'x', 'role': 'Driller'}),
            ('no email', {'password': created_secret, 'name': 'x', 'role': 'Driller'})):
        status, answer = fn('POST', fa, body)
        check(f'creating an account with {what} is refused with a client error', 400 <= status < 500,
              f'HTTP {status} {short(answer)}')
    check('no account came out of the malformed requests', fx.account_by_email(bad_email) is None)
    base = unchanged(base, 'nothing changed through the malformed requests')

    # --- creating an account ---
    new = {}
    for label, role, badge in (('c1', 'Supervisor', 'TISO-C1'), ('c2', 'Data Logger', 'TISO-C2'),
                               ('c3', 'Administrator', 'TISO-C3')):
        email = fx.email(label)
        status, answer = fn('POST', fa, {'email': email, 'password': created_secret,
                                         'name': f'TISO created {label} {RUN}', 'role': role,
                                         'badgeNumber': badge})
        new_id_ = answer.get('id') if isinstance(answer, dict) else None
        check(f'the founding Administrator creates a {role} account', status == 201 and bool(new_id_),
              f'HTTP {status} {short(answer)}')
        found = new_id_ or fx.account_by_email(email)
        if not found:
            continue
        account = fx.add_account(label, email, found, created_secret)
        everyone.append(found)
        new[label] = account
        st = fx.account_state([found]).get(found, {})
        check(f'the new {role} account has exactly one membership: founding, active, with the'
              ' requested role and badge, and none elsewhere',
              st.get('memberships') == [{'org': F.id, 'role': role, 'status': 'active', 'badge': badge}],
              short(st.get('memberships')))
        check(f'the new {role} account signs in', account.sign_in())
    base = fx.account_state(everyone)
    if 'c3' in new:
        status, answer = fn('GET', new['c3'])
        check('an Administrator created through the function is let in',
              status == 200 and isinstance(answer, dict) and 'users' in answer, f'HTTP {status}')
        status, answer = rest('GET', '/organizations?select=id', new['c3'])
        check('...and reads the founding organization only', answer == [{'id': F.id}], short(answer))

    # --- an email that already exists ---
    probes = []
    for what, email in (('an email that exists only in the second organization', sd.email),
                        ('an email that exists in the founding organization', fd.email),
                        ('the email of the member of both', dual.email)):
        status, answer = fn('POST', fa, {'email': email, 'password': created_secret,
                                         'name': 'TISO taken', 'role': 'Administrator',
                                         'badgeNumber': 'TISO-TAKEN'})
        probes.append((what, status, answer))
        check(f'creating an account with {what} creates nothing', not good(status),
              f'HTTP {status} {short(answer)}')
    base = unchanged(base, 'an existing account is untouched by a create request with its email:'
                           ' same credential, same profile, same memberships, in both organizations')
    check('the second-organization account still signs in with its own secret, and has no founding'
          ' membership', bool(tf.sign_in(sd.email, sd.secret)[0])
          and tf.sign_in(sd.email, created_secret)[0] is None
          and [m['org'] for m in base[sd.id]['memberships']] == [S.id])
    for what, status, answer in probes:
        note(f'admin-users POST with {what}: HTTP {status} {short(answer, 200)}')
    same = len({(s_, json.dumps(a_, sort_keys=True)) for _, s_, a_ in probes}) == 1
    note('admin-users POST: the answer for an email taken in the second organization is '
         + ('the same as' if same else 'different from')
         + ' the answer for an email taken in the founding organization; either way a founding'
           ' Administrator learns from it that an account with that email exists somewhere in the'
           ' project (criteria 32 to 36 say only that creating is unchanged)')

    # --- set-role, delete with records, reactivate, delete without records ---
    if 'c1' in new and 'c2' in new:
        c1, c2 = new['c1'], new['c2']
        status, answer = fn('PATCH', fa, {'id': c1.id, 'action': 'setRole', 'role': 'Driller'})
        st = fx.account_state([c1.id])[c1.id]
        check('set-role on a founding member changes the founding membership and the profile',
              status == 200 and st['memberships'] == [{'org': F.id, 'role': 'Driller', 'status': 'active',
                                                       'badge': 'TISO-C1'}]
              and st['profile_role'] == 'Driller', f'HTTP {status} {short(answer)} {short(st["memberships"])}')
        status, answer = fn('PATCH', fa, {'id': c1.id.upper(), 'action': 'setRole', 'role': 'Driller'})
        check('set-role accepts the target id in upper case', status == 200, f'HTTP {status} {short(answer)}')

        c1.sign_in()
        bh, status, body, row = create('boreholes', c1, mark='by a created account')
        check('the re-roled account, now a Driller, logs a borehole in the founding organization',
              good(status) and row is not None and row.get('org_id') == F.id, f'HTTP {status} {short(body)}')
        status, answer = fn('DELETE', fa, {'id': c1.id})
        st = fx.account_state([c1.id]).get(c1.id)
        check('deleting an account that has records deactivates it instead: answered "deactivated"',
              status == 200 and isinstance(answer, dict) and answer.get('action') == 'deactivated'
              and answer.get('records', 0) >= 1, f'HTTP {status} {short(answer)}')
        check('...the account is banned and its founding membership is deactivated',
              st is not None and st['banned'] is True
              and [m['status'] for m in st['memberships']] == ['deactivated'], short(st and st['memberships']))
        check('...it can no longer sign in', tf.sign_in(c1.email, c1.secret)[0] is None)
        status, body = rest('GET', '/boreholes?select=id', c1)
        check('...and the session it still holds reads nothing', not good(status) or body == [],
              f'HTTP {status} {short(body)}')
        status, body = rest('GET', f'/boreholes?id=eq.{bh}&select=id', fs)
        check('...while its records stay, read by the Supervisor', body == [{'id': bh}], short(body))
        status, answer = fn('GET', fa)
        listed = {u['id']: u for u in (answer.get('users') or [])} if isinstance(answer, dict) else {}
        check('...and it is still listed, as deactivated, with its record count',
              listed.get(c1.id, {}).get('deactivated') is True and listed.get(c1.id, {}).get('records') == 1,
              short(listed.get(c1.id)))

        status, answer = fn('PATCH', fa, {'id': c1.id, 'action': 'reactivate'})
        st = fx.account_state([c1.id]).get(c1.id)
        check('reactivate lifts the ban and the founding membership is active again',
              status == 200 and st is not None and st['banned'] is False
              and [m['status'] for m in st['memberships']] == ['active'],
              f'HTTP {status} {short(answer)} {short(st and st["memberships"])}')
        check('...the account signs in again and reads its borehole',
              c1.sign_in() and rest('GET', f'/boreholes?id=eq.{bh}&select=id', c1)[1] == [{'id': bh}])

        status, answer = fn('DELETE', fa, {'id': c2.id})
        check('deleting an account without records removes it: answered "deleted"',
              status == 200 and isinstance(answer, dict) and answer.get('action') == 'deleted',
              f'HTTP {status} {short(answer)}')
        gone = fx.account_state([c2.id])
        check('...the account, its profile and its membership are gone',
              c2.id not in gone and c2.id not in fx.founding_members())
        check('...and it can no longer sign in', tf.sign_in(c2.email, c2.secret)[0] is None)
        everyone.remove(c2.id)
        del fx.accounts['c2']
        status, answer = fn('DELETE', fa, {'id': c2.id})
        check('deleting it a second time is answered 404 "No such account"',
              status == 404 and answer == NOT_FOUND, f'HTTP {status} {short(answer)}')

    # --- criterion 28 through the function: a direct deactivation survives "reactivate" ---
    fxd = fx['fxd']
    status, answer = fn('PATCH', fa, {'id': fxd.id, 'action': 'reactivate'})
    st = fx.account_state([fxd.id])[fxd.id]
    check('reactivate on an account whose membership was deactivated directly (never banned) leaves'
          ' the membership deactivated', [m['status'] for m in st['memberships']] == ['deactivated'],
          f'HTTP {status} {short(answer)} {short(st["memberships"])}')

    # --- a membership that is removed while the session is still valid ---
    status, body = rest('GET', '/organizations?select=id', fv)
    was_member = body == [{'id': F.id}]
    fx.remove_membership(fv, F.id)
    status, body = rest('GET', '/organizations?select=id', fv)
    status2, body2 = rpc('my_organizations', fv)
    status3, body3 = rest('GET', '/boreholes?select=id', fv)
    bh, status4, body4, row4 = create('boreholes', fv, org=F.id, mark='after removal')
    check('a member whose membership is removed loses access at once, with the session they hold:'
          ' no organization, no records, no insert, and my_organizations() is empty',
          was_member and body == [] and body2 == [] and body3 == [] and not good(status4),
          f'{short(body)} / {short(body2)} / {short(body3)} / HTTP {status4}')
    status, answer = fn('PATCH', fa, {'id': fv.id, 'action': 'setRole', 'role': 'Supervisor'})
    st = fx.account_state([fv.id])[fv.id]
    check('admin-users answers 404 for an account whose founding membership was removed, and does'
          ' not re-enrol it', status == 404 and answer == NOT_FOUND and st['memberships'] == []
          and st['profile_role'] == 'Driller', f'HTTP {status} {short(answer)} {short(st["memberships"])}')

    # --- nothing of the second organization moved during the whole section ---
    final = fx.account_state([fx[x].id for x in ('sa', 'ss', 'sd', 'sx', 'dual')])
    second_now = sorted((m['org'], uid_, m['role'], m['status'], m['badge'])
                        for uid_, row in final.items() for m in row['memberships'] if m['org'] == S.id)
    want = sorted([(S.id, fx['sa'].id, 'Administrator', 'active', 'TISO-SA'),
                   (S.id, fx['ss'].id, 'Supervisor', 'active', 'TISO-SS'),
                   (S.id, fx['sd'].id, 'Driller', 'active', 'TISO-SD'),
                   (S.id, fx['sx'].id, 'Supervisor', 'deactivated', 'TISO-SX'),
                   (S.id, dual.id, 'Supervisor', 'active', 'TISO-DUAL-S')])
    check('after everything admin-users was asked, the second organization\'s memberships are exactly'
          ' as the fixture and the direct deactivation left them', second_now == want, short(second_now, 300))
    check('...and none of its accounts is banned', not [1 for row in final.values() if row['banned']])


# --------------------------------------------------------------------------
# run
# --------------------------------------------------------------------------

def run_section(function, *args):
    try:
        return function(*args)
    except Exception as error:  # a broken section must not hide the others, or skip the tear-down
        traceback.print_exc()
        check(f'section "{function.__name__}" ran to completion', False,
              f'{type(error).__name__}: {short(error, 200)}')
        return None


def _interrupted(signum, _frame):
    raise KeyboardInterrupt(f'signal {signum}')


def main():
    global F, S
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, _interrupted)
    interrupted = False
    try:
        try:
            fx.set_up()
            check('the fixture is set up: a second organization and its accounts', True,
                  f'run {RUN}; removed from an earlier run: {fx.swept_at_start}')
        except tf.FixtureError as error:
            check('the fixture is set up: a second organization and its accounts', False, short(error, 300))
        if fx.ready:
            F = Org('F', fx.founding, fx['fd'], fx['fs'], fx['fa'])
            S = Org('S', fx.second, fx['sd'], fx['ss'], fx['sa'])
            run_section(check_fixture)
            section('2. each role still does what it could, in its own organization')
            run_section(seed, F)
            run_section(seed, S)
            if len(F.rows) == 4 and len(S.rows) == 4:
                run_section(roles, F, fx['fl'])
                run_section(roles, S)
                run_section(records_isolation)
                dual_bh = run_section(dual_member)
                run_section(profiles)
                run_section(memberships_and_organizations)
                run_section(photos_section, dual_bh)
                if photos:
                    run_section(deactivated_members)
                run_section(admin_users)
                section('invariants, read from the database before the tear-down')
                bad = fx.mismatched_children()
                check('no child row anywhere has an organization other than its borehole\'s',
                      not bad, short(bad, 300))
            else:
                check('the seed rows exist, so the isolation checks can run', False)
    except KeyboardInterrupt:
        interrupted = True
        check('the run was not interrupted', False)
    finally:
        section('10. the project is left as it was found')
        try:
            removed = fx.tear_down()
            check('the fixture is removed', True, str(removed))
        except Exception as error:
            check('the fixture is removed', False, f'{type(error).__name__}: {short(error, 300)}')
        try:
            end_state()
        except Exception as error:
            check('the end state could be read', False, f'{type(error).__name__}: {short(error, 300)}')

    passed = sum(1 for _, ok in results if ok)
    if notes:
        print('\nNotes (recorded, not asserted):')
        for text in notes:
            print(f'  - {text}')
    print(f'\n{passed}/{len(results)} passed')
    if passed != len(results):
        print('\nFailed:')
        for name, ok in results:
            if not ok:
                print(f'  - {name}')
    sys.exit(0 if passed == len(results) and not interrupted else 1)


def end_state():
    state = fx.end_state()
    orgs = state['organizations']
    check('exactly one organization exists, the founding one',
          len(orgs) == 1 and orgs[0]['is_founding'] is True, short([o['name'] for o in orgs]))
    check('the accounts are exactly the five kept test accounts',
          sorted(state['accounts']) == sorted(_target.ACCOUNTS), short(state['accounts'], 300))
    members = state['memberships']
    check('there are exactly five memberships: one per kept account, founding, active',
          len(members) == 5 and sorted(m['email'] or '' for m in members) == sorted(_target.ACCOUNTS)
          and all(m['status'] == 'active' and orgs and m['org'] == orgs[0]['id'] for m in members),
          short(members, 300))
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
        added = [k for k in a if k not in b]
        if added:
            note(f'{what}: {len(added)} row(s) appeared during the run that this run did not send'
                 ' (another suite on the same project?)')
    if after['exact'].get('audit_log') != before['exact'].get('audit_log'):
        note(f'audit_log: {before["exact"]["audit_log"][0]} row(s) before,'
             f' {after["exact"]["audit_log"][0]} after')
    print(f'\nend state: {len(orgs)} organization(s), {len(state["accounts"])} account(s),'
          f' {len(members)} membership(s)')


if __name__ == '__main__':
    main()
