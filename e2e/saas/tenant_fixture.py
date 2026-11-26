"""Fixture for e2e/saas/tenant_isolation_e2e.py: a second organization and the
accounts the tenant-isolation suite needs, set up before the checks and
removed after them.

The suites sign in as ordinary users. A second organization cannot be made
that way (nothing in the API may create one), so this fixture alone uses
privileged access, and takes it ONLY from the process environment - never from
`.env.e2e` or any other file:

    DRILL_E2E_DB_URL            a direct Postgres connection to the tested
                                project, as a postgresql URL carrying the
                                user, its secret, the host, port and database
    DRILL_E2E_SERVICE_ROLE_KEY  that project's service-role key, for the Auth
                                admin API (create and delete accounts) and for
                                removing stored photos

Importing this module REFUSES (one line on stderr, exit code 2, through
`_target.refuse`) when:

  - either variable is missing;
  - either one names the production project (PROD_REF in
    scripts/hooks/guard.conf, as read by `_target`);
  - the database URL does not name the project `_target` selected (its ref
    must be a label of the user or of the host), unless both are a local stack;
  - the service-role key is a signed token for a different project or role;
  - `psql` is not installed.

Before it writes anything, `set_up()` also proves that the database and the
API are the same project (the founding organization's id read both ways).

What the fixture owns is recognisable by name, so a run can clean up after an
earlier one that was killed:

  - accounts whose email is  tiso-...@example.com
  - organizations named      TISO ...   (never the founding one)
  - every record, membership and stored photo of those accounts and
    organizations

`sweep()` removes exactly that and nothing else. It runs at the start of
`set_up()` and in `tear_down()`. The five kept accounts of `_target.ACCOUNTS`
are never signed in to, changed or removed here.

Nothing in this file prints the database URL, the service-role key or an
account's secret.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import _target  # noqa: E402  (the path line above has to come first)

import base64  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402
import uuid  # noqa: E402

ENV_DB = 'DRILL_E2E_DB_URL'
ENV_SERVICE = 'DRILL_E2E_SERVICE_ROLE_KEY'

EMAIL_PREFIX = 'tiso-'
EMAIL_DOMAIN = '@example.com'
ORG_PREFIX = 'TISO '
BUCKET = 'drilling-photos'
RECORD_TABLES = ('boreholes', 'pipe_records', 'drilling_events', 'shift_logs')
CHILD_TABLES = RECORD_TABLES[1:]

UUID_RE = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
_LOOPBACK = ('localhost', '127.0.0.1', '::1')


class FixtureError(Exception):
    """The fixture could not do what it was asked. Never carries a secret."""


# --------------------------------------------------------------------------
# privileged configuration: environment only, never production
# --------------------------------------------------------------------------

def _prod_refs():
    refs = getattr(_target, '_prod_refs', None)
    if not refs:
        refs = {_target._read_prod_ref(_target.REPO_ROOT).lower()}
    return {r.lower() for r in refs}


def _checked_db(prod_refs):
    raw = (os.environ.get(ENV_DB) or '').strip()
    if not raw:
        _target.refuse(f'missing {ENV_DB}: the tenant fixture needs a direct database'
                       ' connection, from the environment only')
    lowered = urllib.parse.unquote(raw).lower()
    if any(ref in lowered for ref in prod_refs):
        _target.refuse(f'{ENV_DB} names the production project (PROD_REF in {_target.GUARD_CONF});'
                       ' tests never run against production')
    try:
        parts = urllib.parse.urlsplit(raw)
        host = (parts.hostname or '').lower()
        port = parts.port or 5432
    except ValueError:
        _target.refuse(f'{ENV_DB} is not a valid URL')
    if parts.scheme not in ('postgres', 'postgresql') or not host or not parts.username:
        _target.refuse(f'{ENV_DB} must be a postgresql:// URL with a user and a host')
    user = urllib.parse.unquote(parts.username)
    target_host = (urllib.parse.urlsplit(_target.URL).hostname or '').lower()
    if target_host in _LOOPBACK:
        if host not in _LOOPBACK:
            _target.refuse(f'{ENV_DB} is not local although the tested project is a local stack')
    else:
        labels = set(user.lower().split('.')) | set(host.split('.'))
        if _target.REF not in labels:
            _target.refuse(f'{ENV_DB} does not name the project selected by {_target.ENV_URL}:'
                           ' the fixture writes only to the tested project')
    query = dict(urllib.parse.parse_qsl(parts.query))
    env = {
        'PGHOST': host,
        'PGPORT': str(port),
        'PGUSER': user,
        'PGPASSWORD': urllib.parse.unquote(parts.password or ''),
        'PGDATABASE': urllib.parse.unquote(parts.path.lstrip('/')) or 'postgres',
        'PGCONNECT_TIMEOUT': '30',
        'PGAPPNAME': 'tenant-isolation-fixture',
    }
    if query.get('sslmode'):
        env['PGSSLMODE'] = query['sslmode']
    return env


def _checked_service_key(prod_refs):
    key = (os.environ.get(ENV_SERVICE) or '').strip()
    if not key:
        _target.refuse(f'missing {ENV_SERVICE}: the tenant fixture creates and deletes its'
                       ' accounts through the Auth admin API, with a key from the environment only')
    if any(ref in key.lower() for ref in prod_refs):
        _target.refuse(f'{ENV_SERVICE} names the production project; tests never run against production')
    pieces = key.split('.')
    if len(pieces) == 3:
        try:
            padded = pieces[1] + '=' * (-len(pieces[1]) % 4)
            claims = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        except Exception:
            claims = None
        if isinstance(claims, dict):
            ref = str(claims.get('ref') or '').lower()
            if ref and ref in prod_refs:
                _target.refuse(f'{ENV_SERVICE} is a key of the production project;'
                               ' tests never run against production')
            if ref and ref != _target.REF:
                _target.refuse(f'{ENV_SERVICE} is a key of a different project than'
                               f' the one selected by {_target.ENV_URL}')
            if claims.get('role') not in (None, 'service_role'):
                _target.refuse(f'{ENV_SERVICE} is not a service-role key')
    return key


_refs = _prod_refs()
_PG_ENV = _checked_db(_refs)
_SERVICE_KEY = _checked_service_key(_refs)
_PSQL = shutil.which('psql')
if not _PSQL:
    _target.refuse('psql is not installed: the tenant fixture reaches the database through it')
del _refs


# --------------------------------------------------------------------------
# SQL (through psql; the connection travels in the child's environment)
# --------------------------------------------------------------------------

def _psql(script):
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    env.update(_PG_ENV)
    proc = subprocess.run(
        [_PSQL, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        input=script, capture_output=True, text=True, env=env, timeout=180)
    if proc.returncode != 0:
        raise FixtureError('SQL failed: ' + ' '.join(proc.stderr.split())[:400])
    return proc.stdout


def sql(script):
    """Run statements; nothing is returned."""
    _psql(script)


def query(select):
    """Rows of one SELECT, as a list of dicts."""
    out = _psql("select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (\n"
                + select.strip().rstrip(';') + '\n) t;')
    return json.loads(out)


def uid(value):
    """A uuid as an SQL literal. Anything else is refused, so no text from a
    response ever reaches a statement."""
    text = str(value)
    if not UUID_RE.fullmatch(text):
        raise FixtureError(f'not a uuid: {text[:40]!r}')
    return f"'{text.lower()}'::uuid"


def uids(values):
    values = list(values)
    if not values:
        return "'{}'::uuid[]"
    return 'array[' + ', '.join(uid(v) for v in values) + ']'


def text_lit(value):
    return "'" + str(value).replace("'", "''") + "'"


def texts(values):
    values = list(values)
    if not values:
        return "'{}'::text[]"
    return 'array[' + ', '.join(text_lit(v) for v in values) + ']::text[]'


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def request(method, path, token=None, body=None, data=None, headers=None, auth=True, apikey=None,
            absolute=False):
    """One HTTP request to the tested project. Returns (status, raw bytes).

    `token` is the bearer; without one the api key is sent as the bearer (an
    anonymous request). `auth=False` sends no Authorization header at all."""
    url = path if absolute else _target.URL + path
    payload = None
    last = None
    for _attempt in range(3):
        req = urllib.request.Request(url, method=method)
        if not absolute:
            req.add_header('apikey', apikey or _target.KEY)
            if auth:
                req.add_header('Authorization', 'Bearer ' + (token or apikey or _target.KEY))
        if body is not None:
            payload = json.dumps(body).encode()
            req.add_header('Content-Type', 'application/json')
        elif data is not None:
            payload = data
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        try:
            with urllib.request.urlopen(req, payload, timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            # The request never got an HTTP answer. Only reads are repeated.
            last = e
            if method != 'GET':
                break
    raise FixtureError(f'{method} {path.split("?")[0]} got no HTTP answer: {type(last).__name__}')


def parse(raw):
    text = raw.decode('utf-8', 'replace') if isinstance(raw, (bytes, bytearray)) else raw
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def _service(method, path, body=None, data=None, headers=None):
    status, raw = request(method, path, token=_SERVICE_KEY, apikey=_SERVICE_KEY, body=body,
                          data=data, headers=headers)
    return status, parse(raw)


def sign_in(email, secret):
    """(access token, user id), or (None, None) when the sign-in is refused."""
    status, raw = request('POST', '/auth/v1/token?grant_type=password',
                          body={'email': email, 'password': secret})
    body = parse(raw)
    if status != 200 or not isinstance(body, dict) or not body.get('access_token'):
        return None, None
    return body['access_token'], body['user']['id']


# --------------------------------------------------------------------------
# the fixture
# --------------------------------------------------------------------------

class Account:
    def __init__(self, label, email, user_id, secret):
        self.label = label
        self.email = email
        self.id = user_id
        self.secret = secret
        self.token = None

    def sign_in(self):
        self.token, _ = sign_in(self.email, self.secret)
        return self.token is not None

    def __repr__(self):
        return f'<{self.label} {self.id[:8]}>'


# label -> (organization(s), role in each, what it is for)
#   F = founding organization, S = the second organization
FOUNDING_ROLES = {
    'fa': 'Administrator',    # the founding Administrator the suite acts as
    'fs': 'Supervisor',
    'fd': 'Driller',
    'fl': 'Data Logger',
    'fx': 'Administrator',    # deactivated directly, mid-run
    'fxd': 'Driller',         # deactivated directly, mid-run, after logging work
    'fv': 'Driller',          # the target refused callers aim at; must never change
}
SECOND_ROLES = {
    'sa': 'Administrator',
    'ss': 'Supervisor',
    'sd': 'Driller',
    'sx': 'Supervisor',       # deactivated directly, mid-run, after logging work
}
# fp: profiles.role Administrator, founding membership Driller
# fh: profiles.role Driller, founding membership Administrator
# dual: Driller in the founding organization, Supervisor in the second


class Fixture:
    def __init__(self):
        self.run = uuid.uuid4().hex[:8]
        self.secret = uuid.uuid4().hex + 'Aa1'
        self.accounts = {}
        self.founding = None
        self.second = None
        self.second_name = f'{ORG_PREFIX}second organization {self.run}'
        self.baseline = None
        self.ready = False

    # -- names ---------------------------------------------------------------

    def email(self, label):
        return f'{EMAIL_PREFIX}{self.run}-{label}{EMAIL_DOMAIN}'

    def __getitem__(self, label):
        return self.accounts[label]

    # -- same project, read both ways -----------------------------------------

    def _prove_same_project(self):
        rows = query('select id from public.organizations where is_founding')
        if len(rows) != 1:
            raise FixtureError(f'expected exactly one founding organization, found {len(rows)}')
        status, body = _service('GET', '/rest/v1/organizations?select=id&is_founding=is.true')
        if status != 200 or not isinstance(body, list) or [r.get('id') for r in body] != [rows[0]['id']]:
            raise FixtureError('the database connection and the API do not show the same founding'
                               ' organization: they are not the same project, nothing was written')
        self.founding = rows[0]['id']

    # -- clean-up --------------------------------------------------------------

    def sweep(self):
        """Remove everything the fixture names, from this run or an earlier
        one: its accounts, its organizations, and their rows and photos."""
        owned = query(f"""
            select
              (select coalesce(jsonb_agg(id), '[]'::jsonb) from auth.users
                where email like {text_lit(EMAIL_PREFIX + '%' + EMAIL_DOMAIN)}) as users,
              (select coalesce(jsonb_agg(id), '[]'::jsonb) from public.organizations
                where name like {text_lit(ORG_PREFIX + '%')} and not is_founding) as orgs
        """)[0]
        users, orgs = owned['users'], owned['orgs']
        if not users and not orgs:
            return {'users': 0, 'organizations': 0, 'photos': 0}

        first = texts(users + orgs)
        photos = [r['name'] for r in query(f"""
            select name from storage.objects
             where bucket_id = {text_lit(BUCKET)}
               and (split_part(name, '/', 1) = any({first})
                    or split_part(name, '/', 2) = any({texts(users)})
                    or owner = any({uids(users)}))
        """)]
        for start in range(0, len(photos), 100):
            _service('DELETE', f'/storage/v1/object/{BUCKET}', body={'prefixes': photos[start:start + 100]})

        u, o = uids(users), uids(orgs)
        mine = f'(created_by = any({u}) or org_id = any({o}))'
        statements = []
        for table in CHILD_TABLES:
            statements.append(
                f'delete from public.{table} where {mine} or borehole_id in'
                f' (select id from public.boreholes where {mine});')
        statements.append(f'delete from public.boreholes where {mine};')
        # Subscriptions reference organizations (SaaS Phase 3); no such table before it.
        statements.append("do $$ begin if to_regclass('public.subscriptions') is not null then"
                          f' delete from public.subscriptions where org_id = any({o}); end if; end $$;')
        statements.append(f'delete from public.memberships where org_id = any({o});')
        statements.append(f'delete from public.organizations where id = any({o}) and not is_founding;')
        sql('begin;\n' + '\n'.join(statements) + '\ncommit;')

        for user in users:
            _service('DELETE', f'/auth/v1/admin/users/{user}')
        left = query(f'select id from auth.users where id = any({u})')
        if left:
            # The Auth API would not remove them; they are this fixture's own
            # accounts and their rows are gone, so remove them directly.
            sql(f'delete from auth.users where id = any({u})'
                f" and email like {text_lit(EMAIL_PREFIX + '%' + EMAIL_DOMAIN)};")
        return {'users': len(users), 'organizations': len(orgs), 'photos': len(photos)}

    # -- what the project holds, for the before/after comparison ----------------

    def fingerprint(self):
        """What a run must leave as it was.

        'exact': counts and content digests of the accounts, profiles,
        memberships, organizations and platform administrators; these must be
        identical before and after.
        'rows': for the four record tables and the stored photos, a digest per
        row. Every row present before must be present and identical after;
        rows that something else adds meanwhile (another suite running on the
        same project) are not this fixture's to judge."""
        parts = []
        for table in ('profiles', 'organizations'):
            parts.append(f"""
                select {text_lit(table)} as what, count(*) as n,
                       md5(coalesce(string_agg(md5(t::text), '' order by t.id), '')) as digest
                  from public.{table} t""")
        parts.append("""
            select 'memberships', count(*),
                   md5(coalesce(string_agg(md5(t::text), '' order by t.org_id, t.user_id), ''))
              from public.memberships t""")
        parts.append("""
            select 'accounts', count(*),
                   md5(coalesce(string_agg(md5(concat_ws('|', id, email, banned_until,
                       encrypted_password, deleted_at)), '' order by id), ''))
              from auth.users""")
        parts.append("select 'platform_admins', count(*), '' from public.platform_admins")
        parts.append("select 'audit_log', count(*), '' from public.audit_log")
        exact = {r['what']: [r['n'], r['digest']] for r in query(' union all '.join(parts))}

        parts = [f"select {text_lit(t)} as what, t.id::text as key, md5(t::text) as digest"
                 f' from public.{t} t' for t in RECORD_TABLES]
        parts.append(f"""
            select 'photos', name, md5(concat_ws('|', owner, metadata ->> 'eTag'))
              from storage.objects where bucket_id = {text_lit(BUCKET)}""")
        rows = {t: {} for t in RECORD_TABLES + ('photos',)}
        for r in query(' union all '.join(parts)):
            rows[r['what']][r['key']] = r['digest']
        return {'exact': exact, 'rows': rows}

    def end_state(self):
        """Facts about the project after tear-down, for the final assertion."""
        row = query(f"""
            select
              (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name,
                      'is_founding', is_founding) order by created_at), '[]'::jsonb)
                 from public.organizations) as organizations,
              (select coalesce(jsonb_agg(email order by email), '[]'::jsonb) from auth.users) as accounts,
              (select coalesce(jsonb_agg(jsonb_build_object('email', u.email, 'org', m.org_id,
                      'status', m.status, 'role', m.role) order by u.email), '[]'::jsonb)
                 from public.memberships m left join auth.users u on u.id = m.user_id) as memberships,
              (select count(*) from auth.users
                where email like {text_lit(EMAIL_PREFIX + '%' + EMAIL_DOMAIN)}) as fixture_accounts,
              (select count(*) from public.organizations
                where name like {text_lit(ORG_PREFIX + '%')}) as fixture_organizations
        """)[0]
        row['fingerprint'] = self.fingerprint()
        return row

    # -- set-up ------------------------------------------------------------------

    def _create_account(self, label):
        email = self.email(label)
        status, body = _service('POST', '/auth/v1/admin/users', body={
            'email': email, 'password': self.secret, 'email_confirm': True,
            'user_metadata': {'name': f'TISO {label} {self.run}'},
        })
        if status not in (200, 201) or not isinstance(body, dict) or not body.get('id'):
            raise FixtureError(f'could not create the account {label}: HTTP {status}'
                               f' {str(body)[:160]}')
        account = Account(label, email, body['id'], self.secret)
        self.accounts[label] = account
        return account

    def set_up(self):
        self._prove_same_project()
        self.swept_at_start = self.sweep()
        self.baseline = self.fingerprint()

        second = str(uuid.uuid4())
        sql(f'insert into public.organizations (id, name) values ({uid(second)},'
            f' {text_lit(self.second_name)});')
        self.second = second
        # Without a subscription an organization has no access (SaaS Phase 3, D3-1).
        sql("do $$ begin if to_regclass('public.subscriptions') is not null then"
            " insert into public.subscriptions (org_id, plan_id, status)"
            f" values ({uid(second)}, 'standard', 'active') on conflict (org_id) do nothing; end if; end $$;")

        labels = list(FOUNDING_ROLES) + list(SECOND_ROLES) + ['fp', 'fh', 'dual']
        for label in labels:
            self._create_account(label)

        f, s = uid(self.founding), uid(self.second)
        script = ['begin;']
        for label, role in FOUNDING_ROLES.items():
            script.append(
                f'update public.profiles set role = {text_lit(role)},'
                f" badge_number = {text_lit('TISO-' + label.upper())} where id = {uid(self[label].id)};")
        for label, role in SECOND_ROLES.items():
            a = uid(self[label].id)
            badge = text_lit('TISO-' + label.upper())
            script.append(f'update public.profiles set role = {text_lit(role)},'
                          f' badge_number = {badge} where id = {a};')
            script.append(f'delete from public.memberships where user_id = {a} and org_id = {f};')
            script.append('insert into public.memberships (org_id, user_id, role, status, badge_number)'
                          f" values ({s}, {a}, {text_lit(role)}, 'active', {badge});")
        fp, fh, dual = uid(self['fp'].id), uid(self['fh'].id), uid(self['dual'].id)
        script += [
            # profile says Administrator, the founding membership says Driller
            f"update public.profiles set role = 'Administrator', badge_number = 'TISO-FP-PROFILE'"
            f' where id = {fp};',
            f"update public.memberships set role = 'Driller', badge_number = 'TISO-FP-MEMBER'"
            f' where user_id = {fp} and org_id = {f};',
            # the membership says Administrator, the profile was set to Driller by hand
            f"update public.memberships set role = 'Administrator', badge_number = 'TISO-FH'"
            f' where user_id = {fh} and org_id = {f};',
            f"update public.profiles set role = 'Driller' where id = {fh};",
            f"update public.memberships set role = 'Administrator' where user_id = {fh} and org_id = {f};",
            # one account in both organizations
            f"update public.profiles set badge_number = 'TISO-DUAL-F' where id = {dual};",
            'insert into public.memberships (org_id, user_id, role, status, badge_number)'
            f" values ({s}, {dual}, 'Supervisor', 'active', 'TISO-DUAL-S');",
            'commit;',
        ]
        sql('\n'.join(script))

        for account in self.accounts.values():
            if not account.sign_in():
                raise FixtureError(f'the fixture account {account.label} could not sign in')
        self.ready = True

    def expected_memberships(self):
        """label -> the memberships set_up() intends, as sorted (org, role, status)."""
        f, s = self.founding, self.second
        want = {}
        for label, role in FOUNDING_ROLES.items():
            want[label] = [(f, role, 'active')]
        for label, role in SECOND_ROLES.items():
            want[label] = [(s, role, 'active')]
        want['fp'] = [(f, 'Driller', 'active')]
        want['fh'] = [(f, 'Administrator', 'active')]
        want['dual'] = sorted([(f, 'Driller', 'active'), (s, 'Supervisor', 'active')])
        return want

    def add_account(self, label, email, user_id, secret):
        """Register an account the suite created through the application, so
        its state can be read back. (Its name already puts it in the sweep.)"""
        self.accounts[label] = Account(label, email, user_id, secret)
        return self.accounts[label]

    def tear_down(self):
        return self.sweep()

    # -- privileged changes the suite asks for -----------------------------------

    def set_membership_status(self, account, org, status):
        sql(f'update public.memberships set status = {text_lit(status)}'
            f' where user_id = {uid(account.id)} and org_id = {uid(org)};')

    def remove_membership(self, account, org):
        sql(f'delete from public.memberships where user_id = {uid(account.id)}'
            f' and org_id = {uid(org)};')

    def service_upload(self, path, data):
        """Store a photo with the service role, for paths no user may write."""
        status, body = _service('POST', f'/storage/v1/object/{BUCKET}/{path}', data=data,
                                headers={'Content-Type': 'image/jpeg'})
        if status not in (200, 201):
            raise FixtureError(f'service upload failed: HTTP {status} {str(body)[:120]}')

    # -- reading the truth back ----------------------------------------------------

    def account_state(self, ids):
        """user id -> what the account is: email, ban, a digest of its
        credential, profile, and every membership. A missing id is absent."""
        rows = query(f"""
            select u.id, u.email,
                   (u.banned_until is not null and u.banned_until > now()) as banned,
                   md5(coalesce(u.encrypted_password, '')) as credential,
                   p.name, p.role as profile_role, p.badge_number as profile_badge,
                   (select coalesce(jsonb_agg(jsonb_build_object('org', m.org_id, 'role', m.role,
                           'status', m.status, 'badge', m.badge_number) order by m.org_id), '[]'::jsonb)
                      from public.memberships m where m.user_id = u.id) as memberships
              from auth.users u left join public.profiles p on p.id = u.id
             where u.id = any({uids(ids)})
        """)
        return {r['id']: r for r in rows}

    def account_by_email(self, email):
        rows = query(f'select id from auth.users where lower(email) = lower({text_lit(email)})')
        return rows[0]['id'] if rows else None

    def founding_members(self):
        """user id -> the founding membership (role, status, badge)."""
        rows = query(f"""
            select user_id, role, status, badge_number from public.memberships
             where org_id = {uid(self.founding)}""")
        return {r['user_id']: r for r in rows}

    def all_memberships(self):
        return query('select org_id, user_id, role, status, badge_number from public.memberships'
                     ' order by org_id, user_id')

    def organizations(self):
        return query('select id, name, is_founding from public.organizations order by id')

    def record_state(self, ids):
        """row id -> {'table': ..., 'row': the whole row} for every id that
        exists in one of the four record tables."""
        ids = list(ids)
        if not ids:
            return {}
        parts = [f"select {text_lit(t)} as tbl, t.id, to_jsonb(t) as row from public.{t} t"
                 f" where t.id = any({uids(ids)})" for t in RECORD_TABLES]
        return {r['id']: {'table': r['tbl'], 'row': r['row']} for r in query(' union all '.join(parts))}

    def record_counts(self, account):
        """org id -> how many rows of the four tables the account authored there."""
        parts = [f'select org_id from public.{t} where created_by = {uid(account.id)}'
                 for t in RECORD_TABLES]
        rows = query('select org_id, count(*) as n from (' + ' union all '.join(parts)
                     + ') x group by org_id')
        return {r['org_id']: r['n'] for r in rows}

    def mismatched_children(self):
        """Child rows whose organization is not their borehole's."""
        parts = [f"select {text_lit(t)} as tbl, c.id from public.{t} c"
                 ' join public.boreholes b on b.id = c.borehole_id where c.org_id <> b.org_id'
                 for t in CHILD_TABLES]
        return query(' union all '.join(parts))

    def photo_state(self, paths=None):
        """object name -> content tag, for the given names, or for every
        object under a folder of this run's organizations and accounts."""
        if paths is not None:
            where = f'name = any({texts(paths)})'
        else:
            owners = [a.id for a in self.accounts.values()]
            first = texts(owners + [self.second])
            where = (f"(split_part(name, '/', 1) = any({first})"
                     f" or split_part(name, '/', 2) = any({texts(owners)}))")
        rows = query(f"""
            select name, coalesce(metadata ->> 'eTag', '') as tag from storage.objects
             where bucket_id = {text_lit(BUCKET)} and {where}""")
        return {r['name']: r['tag'] for r in rows}
