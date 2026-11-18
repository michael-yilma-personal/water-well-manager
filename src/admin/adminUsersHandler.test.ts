// P1-7, criteria 32 to 36: what the `admin-users` edge function DOES with the
// decisions of ./policy.ts. Added in the validation of f1aabbe.
//
// The function cannot be run as deployed here (no Deno, and no staging in the
// gate); that proof is task P1-3. What can be done here is to run the real
// request handler of supabase/functions/admin-users/index.ts against a
// STAND-IN for the Supabase client that remembers every read and every write:
//
//   - the source is loaded with two lines changed: the `createClient` import
//     from esm.sh is pointed at the stand-in below, and `./policy.ts` at the
//     real policy module. `Deno.env` and `Deno.serve` are provided, and the
//     handler passed to `Deno.serve` is the thing under test;
//   - the stand-in holds accounts, profiles, memberships and records in
//     memory. It compares ids the way PostgreSQL compares uuids (without
//     regard to case). The client made with the caller's token can only say
//     who the caller is; the client made with the service key cannot.
//
// So these tests pin the function's own logic: which status it answers, that
// a refusal writes NOTHING, that the target is checked before the first
// write on every mutating branch, and that profiles.role is never read. They
// say nothing about the real auth server, PostgREST or the mirror triggers:
// P1-3 covers those on staging.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

const FUNCTION_DIR = path.resolve(import.meta.dirname, '../../supabase/functions/admin-users');

// ---------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------

const URL_ = 'http://admin-users-test.invalid';
const SERVICE_KEY = 'service-key-of-the-stand-in';
const ANON_KEY = 'anon-key-of-the-stand-in';

const F = '11111111-1111-4111-8111-111111111111'; // the founding organization
const O = '22222222-2222-4222-8222-222222222222'; // another company

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = id(1); //         founding Administrator; profiles.role says Driller
const LEGACY_ADMIN = id(2); //  profiles.role says Administrator; founding membership Driller
const DRILLER = id(3); //       founding Driller, has logged records
const FRESH = id(4); //         founding Driller, no records
const OFF = id(5); //           founding Supervisor, deactivated, account banned
const INVITED = id(6); //       founding Data Logger, invited
const OTHER_ADMIN = id(7); //   Administrator of the other company only
const DUAL = id(8); //          founding Driller and Supervisor of the other company
const NOBODY = id(9); //        an account with no membership anywhere
const OFF_ADMIN = id(10); //    founding Administrator, deactivated
const INVITED_ADMIN = id(11); // founding Administrator, invited
const MISSING = id(404); //     no such account

type Row = Record<string, any>;

type World = {
  founding: string | null;
  users: Row[];
  profiles: Row[];
  memberships: Row[];
  records: Record<string, Row[]>;
  tokens: Record<string, string>;
  events: string[];
  fail: { founding?: boolean; memberships?: boolean };
};

const UUID_COLUMNS = new Set(['id', 'user_id', 'org_id', 'created_by']);
const same = (column: string, a: unknown, b: unknown) =>
  UUID_COLUMNS.has(column) ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

function newWorld(): World {
  const account = (uid: string, name: string, profileRole: string, banned = false) => ({
    user: {
      id: uid,
      email: `${name}@example.invalid`,
      banned_until: banned ? '2126-01-01T00:00:00Z' : null,
      created_at: '2026-01-01T00:00:00Z',
      last_sign_in_at: null,
    },
    profile: { id: uid, name, role: profileRole, badge_number: `P-${name}` },
  });
  const accounts = [
    account(ADMIN, 'admin', 'Driller'),
    account(LEGACY_ADMIN, 'legacy-admin', 'Administrator'),
    account(DRILLER, 'driller', 'Driller'),
    account(FRESH, 'fresh', 'Driller'),
    account(OFF, 'off', 'Supervisor', true),
    account(INVITED, 'invited', 'Data Logger'),
    account(OTHER_ADMIN, 'other-admin', 'Administrator'),
    account(DUAL, 'dual', 'Driller'),
    account(NOBODY, 'nobody', 'Administrator'),
    account(OFF_ADMIN, 'off-admin', 'Administrator'),
    account(INVITED_ADMIN, 'invited-admin', 'Administrator'),
  ];
  const member = (org: string, uid: string, role: string, status: string, badge: string | null) => ({
    org_id: org, user_id: uid, role, status, badge_number: badge,
  });
  return {
    founding: F,
    users: accounts.map((a) => a.user),
    profiles: accounts.map((a) => a.profile),
    memberships: [
      member(F, ADMIN, 'Administrator', 'active', 'M-admin'),
      member(F, LEGACY_ADMIN, 'Driller', 'active', null),
      member(F, DRILLER, 'Driller', 'active', 'M-driller'),
      member(F, FRESH, 'Driller', 'active', null),
      member(F, OFF, 'Supervisor', 'deactivated', null),
      member(F, INVITED, 'Data Logger', 'invited', null),
      member(O, OTHER_ADMIN, 'Administrator', 'active', null),
      member(F, DUAL, 'Driller', 'active', null),
      member(O, DUAL, 'Supervisor', 'active', null),
      member(F, OFF_ADMIN, 'Administrator', 'deactivated', null),
      member(F, INVITED_ADMIN, 'Administrator', 'invited', null),
    ],
    records: {
      boreholes: [{ id: id(900), created_by: DRILLER }, { id: id(901), created_by: DUAL }],
      pipe_records: [],
      drilling_events: [],
      shift_logs: [],
    },
    tokens: {
      'token-admin': ADMIN,
      'token-legacy-admin': LEGACY_ADMIN,
      'token-driller': DRILLER,
      'token-off': OFF,
      'token-other-admin': OTHER_ADMIN,
      'token-dual': DUAL,
      'token-nobody': NOBODY,
      'token-off-admin': OFF_ADMIN,
      'token-invited-admin': INVITED_ADMIN,
    },
    events: [],
    fail: {},
  };
}

let world: World = newWorld();

function tableRows(table: string): Row[] {
  if (table === 'profiles') return world.profiles;
  if (table === 'memberships') return world.memberships;
  if (table in world.records) return world.records[table];
  throw new Error(`the stand-in has no table ${table}`);
}

function fromTable(table: string) {
  const q = {
    op: 'select' as 'select' | 'update' | 'insert' | 'upsert' | 'delete',
    columns: '*',
    options: undefined as Row | undefined,
    filters: [] as Array<[string, unknown]>,
    patch: undefined as Row | undefined,
    returning: false,
  };
  const describe = () => q.filters.map(([c, v]) => `${c}=${String(v).toLowerCase()}`).join('&');
  const run = () => {
    const rows = tableRows(table).filter((r) => q.filters.every(([c, v]) => same(c, r[c], v)));
    if (q.op === 'select') {
      world.events.push(`read:${table}:${q.columns}:${describe()}`);
      if (table === 'memberships' && world.fail.memberships) {
        return { data: null, count: null, error: { message: 'memberships could not be read' } };
      }
      const names = q.columns.split(',').map((c) => c.trim());
      const data = rows.map((r) => (names.includes('*') ? { ...r } : Object.fromEntries(names.map((n) => [n, r[n]]))));
      return { data: q.options?.head ? null : data, count: q.options?.count ? rows.length : null, error: null };
    }
    world.events.push(`write:${q.op}:${table}:${describe()}:${JSON.stringify(q.patch ?? null)}`);
    if (q.op === 'update') {
      for (const r of rows) {
        Object.assign(r, q.patch);
        // What the mirror trigger does (decision 27): role and badge reach the founding membership.
        if (table === 'profiles' && world.founding) {
          const m = world.memberships.find((x) => x.org_id === world.founding && same('user_id', x.user_id, r.id));
          if (m && q.patch && 'role' in q.patch) m.role = q.patch.role;
          if (m && q.patch && 'badge_number' in q.patch) m.badge_number = q.patch.badge_number;
        }
      }
    }
    return { data: q.returning ? rows.map((r) => ({ ...r })) : null, count: null, error: null };
  };
  const api: Row = {
    select(columns = '*', options?: Row) {
      if (q.op === 'select') {
        q.columns = columns;
        q.options = options;
      } else {
        q.returning = true;
      }
      return api;
    },
    update(patch: Row) { q.op = 'update'; q.patch = patch; return api; },
    insert(patch: Row) { q.op = 'insert'; q.patch = patch; return api; },
    upsert(patch: Row) { q.op = 'upsert'; q.patch = patch; return api; },
    delete() { q.op = 'delete'; return api; },
    eq(column: string, value: unknown) { q.filters.push([column, value]); return api; },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      return Promise.resolve().then(run).then(resolve, reject);
    },
  };
  return api;
}

function createClient(url: string, key: string, options?: Row) {
  assert.equal(url, URL_, 'a client was made for another URL');
  if (key === ANON_KEY) {
    // The caller's own client: it says who is calling and nothing else.
    const header: string = options?.global?.headers?.Authorization ?? '';
    const refuse = () => { throw new Error('the client made with the caller\'s token was used for data'); };
    return {
      auth: {
        async getUser() {
          const uid = world.tokens[header.replace(/^Bearer /, '')];
          return uid
            ? { data: { user: { id: uid } }, error: null }
            : { data: { user: null }, error: { message: 'invalid JWT' } };
        },
        admin: { listUsers: refuse, createUser: refuse, updateUserById: refuse, deleteUser: refuse },
      },
      from: refuse,
      rpc: refuse,
    };
  }
  assert.equal(key, SERVICE_KEY, 'a client was made with an unknown key');
  return {
    auth: {
      async getUser() { throw new Error('the caller was identified with the service-role client'); },
      admin: {
        async listUsers() {
          world.events.push('read:auth.listUsers');
          return { data: { users: world.users.map((u) => ({ ...u })) }, error: null };
        },
        async createUser(attrs: Row) {
          world.events.push(`write:auth.createUser:${attrs.email}`);
          if (world.users.some((u) => u.email === attrs.email)) {
            return { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
          }
          const user = { id: id(5000 + world.users.length), email: attrs.email, banned_until: null, created_at: '2026-11-17T00:00:00Z', last_sign_in_at: null };
          world.users.push(user);
          // The signup trigger: a profile, as a Driller. The mirror: a founding membership.
          const badge = attrs.user_metadata?.badge_number || null;
          world.profiles.push({ id: user.id, name: attrs.user_metadata?.name || String(attrs.email).split('@')[0], role: 'Driller', badge_number: badge });
          if (world.founding) {
            world.memberships.push({ org_id: world.founding, user_id: user.id, role: 'Driller', status: 'active', badge_number: badge });
          }
          return { data: { user: { ...user } }, error: null };
        },
        async updateUserById(uid: string, attrs: Row) {
          world.events.push(`write:auth.updateUserById:${String(uid).toLowerCase()}:${JSON.stringify(attrs)}`);
          const user = world.users.find((u) => same('id', u.id, uid));
          if (!user) return { data: { user: null }, error: { message: 'User not found' } };
          if ('ban_duration' in attrs) user.banned_until = attrs.ban_duration === 'none' ? null : '2126-01-01T00:00:00Z';
          return { data: { user: { ...user } }, error: null };
        },
        async deleteUser(uid: string) {
          world.events.push(`write:auth.deleteUser:${String(uid).toLowerCase()}`);
          if (!world.users.some((u) => same('id', u.id, uid))) return { data: null, error: { message: 'User not found' } };
          world.users = world.users.filter((u) => !same('id', u.id, uid));
          world.profiles = world.profiles.filter((p) => !same('id', p.id, uid));
          world.memberships = world.memberships.filter((m) => !same('user_id', m.user_id, uid));
          return { data: null, error: null };
        },
      },
    },
    from: fromTable,
    async rpc(name: string) {
      world.events.push(`rpc:${name}`);
      if (name !== 'founding_org_id') return { data: null, error: { message: `the stand-in has no function ${name}` } };
      if (world.fail.founding) return { data: null, error: { message: 'founding_org_id could not be called' } };
      return { data: world.founding, error: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Loading the real handler
// ---------------------------------------------------------------------------

type Handler = (req: Request) => Promise<Response>;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-users-handler-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function loadHandler(): Promise<Handler> {
  const source = fs.readFileSync(path.join(FUNCTION_DIR, 'index.ts'), 'utf8');
  const clientImport = /import\s*\{\s*createClient\s*\}\s*from\s*['"]https:\/\/esm\.sh\/@supabase\/supabase-js@2['"];?/;
  const policyImport = /(from\s*)['"]\.\/policy\.ts['"]/;
  assert.match(source, clientImport, 'index.ts no longer imports createClient the way this test rewrites');
  assert.match(source, policyImport, 'index.ts no longer imports ./policy.ts');
  const rewritten = source
    .replace(clientImport, 'const createClient = (globalThis as any).__adminUsersTest.createClient;')
    .replace(policyImport, `$1${JSON.stringify(pathToFileURL(path.join(FUNCTION_DIR, 'policy.ts')).href)}`);
  assert.doesNotMatch(rewritten, /https?:\/\/esm\.sh/, 'index.ts imports something else from the network');

  let handler: Handler | undefined;
  const g = globalThis as any;
  g.__adminUsersTest = { createClient };
  g.Deno = {
    env: {
      get: (name: string) =>
        ({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: ANON_KEY } as Row)[name],
    },
    serve: (h: Handler) => { handler = h; },
  };
  const file = path.join(scratch, 'index.ts');
  fs.writeFileSync(file, rewritten);
  await import(pathToFileURL(file).href);
  assert.ok(handler, 'index.ts did not pass a handler to Deno.serve');
  return handler;
}

const handler = await loadHandler();

type Answer = { status: number; body: any; writes: string[]; events: string[] };

/** One request against a FRESH world (or the one given), and what it left behind. */
async function call(method: string, token: string | null, body?: unknown, prepare?: (w: World) => void): Promise<Answer> {
  world = newWorld();
  prepare?.(world);
  return callIn(method, token, body);
}

async function callIn(method: string, token: string | null, body?: unknown): Promise<Answer> {
  const before = world.events.length;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = token.startsWith('raw:') ? token.slice(4) : `Bearer ${token}`;
  const res = await handler(new Request(`${URL_}/functions/v1/admin-users`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* the preflight answers plain text */ }
  const events = world.events.slice(before);
  return { status: res.status, body: parsed, events, writes: events.filter((e) => e.startsWith('write:')) };
}

/** Every request the function accepts, each acting on `target`. */
const REQUESTS = (target: unknown): Array<[string, string, unknown]> => [
  ['list', 'GET', undefined],
  ['create', 'POST', { email: 'new@example.invalid', password: 'long-enough-1', name: 'New', role: 'Supervisor', badgeNumber: 'N-1' }],
  ['setRole', 'PATCH', { id: target, action: 'setRole', role: 'Administrator' }],
  ['reactivate', 'PATCH', { id: target, action: 'reactivate' }],
  ['delete', 'DELETE', { id: target }],
];

/** The three requests that act on an existing account. */
const TARGETED = (target: unknown) => REQUESTS(target).slice(2);

// ---------------------------------------------------------------------------
// Criterion 32: who may call
// ---------------------------------------------------------------------------

test('without an Authorization header every request is 401, and nothing is read or written with the service key', async () => {
  for (const [name, method, body] of REQUESTS(DRILLER)) {
    const a = await call(method, null, body);
    assert.equal(a.status, 401, name);
    assert.deepEqual(a.events, [], name);
  }
});

test('a header that is not a bearer token, or a token no session belongs to, is 401 and writes nothing', async () => {
  for (const token of ['raw:Basic abc', 'raw:token-admin', 'token-of-nobody', '']) {
    for (const [name, method, body] of REQUESTS(DRILLER)) {
      const a = await call(method, token, body);
      assert.equal(a.status, 401, `${name} with ${JSON.stringify(token)}`);
      assert.deepEqual(a.writes, [], `${name} with ${JSON.stringify(token)}`);
    }
  }
});

test('an active Administrator of the founding organization is let in, although profiles.role calls them a Driller', async () => {
  const a = await call('GET', 'token-admin');
  assert.equal(a.status, 200);
  assert.ok(Array.isArray(a.body.users));
});

const NOT_ADMINS: Array<[string, string]> = [
  ['token-legacy-admin', 'profiles.role says Administrator but the founding membership says Driller'],
  ['token-driller', 'a founding Driller'],
  ['token-off', 'a deactivated founding Supervisor'],
  ['token-off-admin', 'a founding Administrator whose membership is deactivated'],
  ['token-invited-admin', 'a founding Administrator whose membership is only invited'],
  ['token-other-admin', 'the Administrator of another organization only'],
  ['token-dual', 'a founding Driller who is Supervisor of another organization'],
  ['token-nobody', 'an account with no membership whose profiles.role says Administrator'],
];

for (const [token, who] of NOT_ADMINS) {
  test(`403 for every request, and nothing written, when the caller is ${who}`, async () => {
    for (const [name, method, body] of REQUESTS(FRESH)) {
      const a = await call(method, token, body);
      assert.equal(a.status, 403, name);
      assert.deepEqual(a.writes, [], name);
      assert.equal(a.body.users, undefined, name);
    }
  });
}

test('with no founding organization the answer is 403 for everyone, the legacy Administrators included, and nothing is written', async () => {
  for (const token of ['token-admin', 'token-legacy-admin', 'token-other-admin']) {
    for (const [name, method, body] of REQUESTS(FRESH)) {
      const a = await call(method, token, body, (w) => { w.founding = null; });
      assert.equal(a.status, 403, `${name} as ${token}`);
      assert.deepEqual(a.writes, [], `${name} as ${token}`);
    }
  }
});

test('when the founding organization is another one, its Administrator is let in and the old one is not', async () => {
  const moved = (w: World) => { w.founding = O; };
  assert.equal((await call('GET', 'token-other-admin', undefined, moved)).status, 200);
  assert.equal((await call('GET', 'token-admin', undefined, moved)).status, 403);
});

test('profiles.role is never read: not to authorise, not to list, not on any request', async () => {
  for (const token of ['token-admin', 'token-legacy-admin', 'token-nobody']) {
    for (const target of [DRILLER, FRESH, OFF, OTHER_ADMIN, DUAL, MISSING]) {
      for (const [name, method, body] of REQUESTS(target)) {
        const a = await call(method, token, body);
        for (const e of a.events.filter((x) => x.startsWith('read:profiles:'))) {
          const columns = e.split(':')[2].split(',').map((c) => c.trim());
          assert.ok(!columns.includes('role') && !columns.includes('*'), `${name} as ${token} read ${e}`);
        }
      }
    }
  }
});

test('the caller is authorised from memberships read with the service key, before anything else is read', async () => {
  const a = await call('GET', 'token-admin');
  assert.equal(a.events[0], 'rpc:founding_org_id');
  assert.match(a.events[1], new RegExp(`^read:memberships:.*:user_id=${ADMIN}$`));
});

test('(Developer\'s choice) a failed lookup of the founding organization lets nobody in: 500, nothing written', async () => {
  for (const [name, method, body] of REQUESTS(FRESH)) {
    const a = await call(method, 'token-admin', body, (w) => { w.fail.founding = true; });
    assert.equal(a.status, 500, name);
    assert.deepEqual(a.writes, [], name);
    assert.equal(a.body.users, undefined, name);
  }
});

test('(Developer\'s choice) a failed lookup of the memberships lets nobody in and acts on nobody: 500, nothing written', async () => {
  for (const [name, method, body] of REQUESTS(FRESH)) {
    const a = await call(method, 'token-admin', body, (w) => { w.fail.memberships = true; });
    assert.equal(a.status, 500, name);
    assert.deepEqual(a.writes, [], name);
    assert.equal(a.body.users, undefined, name);
  }
});

test('a failed lookup of the TARGET\'s memberships, after the caller passed, changes nothing', async () => {
  for (const [name, method, body] of TARGETED(FRESH)) {
    world = newWorld();
    // The first read of memberships (the caller's) succeeds; the second (the target's) fails.
    let reads = 0;
    Object.defineProperty(world.fail, 'memberships', { get: () => (reads += 1) > 1 });
    const a = await callIn(method, 'token-admin', body);
    assert.equal(reads, 2, `${name}: memberships were read ${reads} time(s)`);
    assert.ok(a.status >= 500, `${name}: ${a.status}`);
    assert.deepEqual(a.writes, [], name);
  }
});

test('the preflight is answered without a session and touches nothing', async () => {
  const a = await call('OPTIONS', null);
  assert.equal(a.status, 200);
  assert.deepEqual(a.events, []);
});

// ---------------------------------------------------------------------------
// Criterion 33: the list
// ---------------------------------------------------------------------------

test('the list holds exactly the accounts with a founding membership, whatever its status', async () => {
  const a = await call('GET', 'token-admin');
  assert.equal(a.status, 200);
  assert.deepEqual(
    a.body.users.map((u: Row) => u.id).sort(),
    [ADMIN, LEGACY_ADMIN, DRILLER, FRESH, OFF, INVITED, DUAL, OFF_ADMIN, INVITED_ADMIN].sort(),
  );
});

test('the list leaves out an account of another organization and an account with no membership, and says nothing about them', async () => {
  const a = await call('GET', 'token-admin');
  const text = JSON.stringify(a.body);
  for (const [uid, name] of [[OTHER_ADMIN, 'other-admin'], [NOBODY, 'nobody']]) {
    assert.ok(!text.includes(uid), `${name}: id`);
    assert.ok(!text.includes(`${name}@example.invalid`), `${name}: email`);
  }
});

test('role and badge in the list are the founding membership\'s, not the profile\'s and not another organization\'s', async () => {
  const a = await call('GET', 'token-admin');
  const by = new Map<string, Row>(a.body.users.map((u: Row) => [u.id, u]));
  assert.equal(by.get(ADMIN)!.role, 'Administrator'); //        profile: Driller
  assert.equal(by.get(ADMIN)!.badgeNumber, 'M-admin'); //       profile: P-admin
  assert.equal(by.get(LEGACY_ADMIN)!.role, 'Driller'); //       profile: Administrator
  assert.equal(by.get(LEGACY_ADMIN)!.badgeNumber, ''); //       profile: P-legacy-admin
  assert.equal(by.get(DUAL)!.role, 'Driller'); //               other organization: Supervisor
  assert.equal(by.get(OFF_ADMIN)!.role, 'Administrator');
});

test('the list marks the caller, and nobody else, as themselves', async () => {
  const a = await call('GET', 'token-admin');
  assert.deepEqual(a.body.users.filter((u: Row) => u.isSelf).map((u: Row) => u.id), [ADMIN]);
});

test('(Developer\'s choice) `deactivated` in the list is the account\'s ban, and a ban that has run out is not one', async () => {
  const a = await call('GET', 'token-admin', undefined, (w) => {
    w.users.find((u) => u.id === FRESH)!.banned_until = '2020-01-01T00:00:00Z';
  });
  const by = new Map<string, Row>(a.body.users.map((u: Row) => [u.id, u]));
  assert.equal(by.get(OFF)!.deactivated, true);
  assert.equal(by.get(FRESH)!.deactivated, false);
  assert.equal(by.get(DRILLER)!.deactivated, false);
});

test('listing writes nothing', async () => {
  assert.deepEqual((await call('GET', 'token-admin')).writes, []);
});

// ---------------------------------------------------------------------------
// Criterion 34: a target outside the founding organization
// ---------------------------------------------------------------------------

const OUTSIDE: Array<[string, unknown]> = [
  ['an id no account has', MISSING],
  ['the Administrator of another organization', OTHER_ADMIN],
  ['that id in upper case', OTHER_ADMIN.toUpperCase()],
  ['an account with no membership', NOBODY],
  ['text that is not an id', 'not-an-id'],
  ['an id with SQL after it', `${DRILLER}' or '1'='1`],
  ['a PostgREST filter in place of an id', 'in.(1,2)'],
  ['a number', 42],
  ['an object', { id: DRILLER }],
  ['a list holding a founding member\'s id', [DRILLER]],
  ['true', true],
];

for (const [what, target] of OUTSIDE) {
  test(`changing a role, reactivating and deleting answer 404 "No such account" and change nothing when the target is ${what}`, async () => {
    for (const [name, method, body] of TARGETED(target)) {
      const a = await call(method, 'token-admin', body);
      assert.equal(a.status, 404, name);
      assert.deepEqual(a.body, { error: 'No such account' }, name);
      assert.deepEqual(a.writes, [], name);
    }
  });
}

test('an account of another organization and an id that does not exist get the very same answer, byte for byte', async () => {
  for (const [name, method] of TARGETED(MISSING)) {
    const body = (target: string) => TARGETED(target).find(([n]) => n === name)![2];
    const missing = await call(method, 'token-admin', body(MISSING));
    for (const target of [OTHER_ADMIN, NOBODY]) {
      const there = await call(method, 'token-admin', body(target));
      assert.deepEqual({ status: there.status, body: there.body }, { status: missing.status, body: missing.body }, name);
    }
  }
});

test('an account of another organization that has logged records is not banned by a delete: 404, nothing written', async () => {
  const a = await call('DELETE', 'token-admin', { id: OTHER_ADMIN }, (w) => {
    w.records.boreholes.push({ id: id(902), created_by: OTHER_ADMIN });
  });
  assert.equal(a.status, 404);
  assert.deepEqual(a.writes, []);
});

test('a request without an id is refused and changes nothing', async () => {
  for (const missing of [undefined, null, '', 0]) {
    for (const [name, method, body] of TARGETED(missing)) {
      const a = await call(method, 'token-admin', body);
      assert.ok(a.status >= 400 && a.status < 500, `${name} with ${JSON.stringify(missing)}: ${a.status}`);
      assert.deepEqual(a.writes, [], name);
    }
  }
});

// ---------------------------------------------------------------------------
// Criterion 35: a target that also belongs to another organization
// ---------------------------------------------------------------------------

test('changing a role, reactivating and deleting answer 409 and change nothing when the target is also a member of another organization', async () => {
  for (const [name, method, body] of TARGETED(DUAL)) {
    const a = await call(method, 'token-admin', body);
    assert.equal(a.status, 409, name);
    assert.equal(typeof a.body.error, 'string', name);
    assert.deepEqual(a.writes, [], name);
  }
});

test('... whatever the two memberships\' statuses, and although the account has logged records (no ban in place of the delete)', async () => {
  for (const here of ['invited', 'active', 'deactivated']) {
    for (const there of ['invited', 'active', 'deactivated']) {
      for (const [name, method, body] of TARGETED(DUAL)) {
        const a = await call(method, 'token-admin', body, (w) => {
          w.memberships.find((m) => m.user_id === DUAL && m.org_id === F)!.status = here;
          w.memberships.find((m) => m.user_id === DUAL && m.org_id === O)!.status = there;
        });
        assert.equal(a.status, 409, `${name}: founding ${here}, other ${there}`);
        assert.deepEqual(a.writes, [], `${name}: founding ${here}, other ${there}`);
      }
    }
  }
});

test('the 409 is not the 404: the two refusals differ only for an account the caller can already see in the list', async () => {
  const listed = (await call('GET', 'token-admin')).body.users.map((u: Row) => u.id);
  assert.ok(listed.includes(DUAL));
  assert.ok(!listed.includes(OTHER_ADMIN));
});

// ---------------------------------------------------------------------------
// Criterion 36: creating; the rules about oneself; the allowed changes
// ---------------------------------------------------------------------------

test('creating an account answers 201 and leaves it with the requested role and badge, in the profile and (mirrored) in the founding membership', async () => {
  const a = await call('POST', 'token-admin', { email: ' New@Example.invalid ', password: 'long-enough-1', name: 'New', role: 'Supervisor', badgeNumber: 'N-1' });
  assert.equal(a.status, 201);
  assert.equal(a.body.email, 'new@example.invalid');
  assert.equal(a.body.role, 'Supervisor');
  const created = world.users.find((u) => u.email === 'new@example.invalid')!;
  assert.equal(a.body.id, created.id);
  assert.deepEqual(world.profiles.find((p) => p.id === created.id), { id: created.id, name: 'New', role: 'Supervisor', badge_number: 'N-1' });
  assert.deepEqual(
    world.memberships.filter((m) => m.user_id === created.id),
    [{ org_id: F, user_id: created.id, role: 'Supervisor', status: 'active', badge_number: 'N-1' }],
  );
});

test('creating writes the new account and its own profile, and nothing else', async () => {
  const a = await call('POST', 'token-admin', { email: 'new@example.invalid', password: 'long-enough-1', role: 'Driller' });
  const created = world.users.find((u) => u.email === 'new@example.invalid')!;
  assert.equal(a.writes.length, 2);
  assert.equal(a.writes[0], 'write:auth.createUser:new@example.invalid');
  assert.ok(a.writes[1].startsWith(`write:update:profiles:id=${created.id}:`), a.writes[1]);
});

test('creating never writes memberships itself: enrolment is the database\'s (the mirror), in the founding organization only', async () => {
  const a = await call('POST', 'token-admin', { email: 'new@example.invalid', password: 'long-enough-1', role: 'Administrator' });
  assert.ok(a.writes.every((w) => !w.includes(':memberships:')), a.writes.join(' | '));
});

test('creating with a role outside the four, a short password or no email is 400 and writes nothing', async () => {
  const ok = { email: 'new@example.invalid', password: 'long-enough-1', role: 'Driller' };
  for (const bad of [{ ...ok, role: 'admin' }, { ...ok, role: 'Owner' }, { ...ok, password: 'short' }, { ...ok, email: '' }, { ...ok, password: '' }]) {
    const a = await call('POST', 'token-admin', bad);
    assert.equal(a.status, 400, JSON.stringify(bad));
    assert.deepEqual(a.writes, [], JSON.stringify(bad));
  }
});

test('an Administrator cannot change their own role or remove their own account: 400, nothing written', async () => {
  for (const [name, method, body] of [TARGETED(ADMIN)[0], TARGETED(ADMIN)[2]]) {
    const a = await call(method, 'token-admin', body);
    assert.equal(a.status, 400, name);
    assert.deepEqual(a.writes, [], name);
  }
});

test('... nor by sending their own id in upper case, which the database takes for the same id', async () => {
  for (const [name, method, body] of [TARGETED(ADMIN.toUpperCase())[0], TARGETED(ADMIN.toUpperCase())[2]]) {
    const a = await call(method, 'token-admin', body);
    assert.deepEqual(a.writes, [], `${name}: wrote ${a.writes.join(' | ')}`);
    assert.ok(a.status >= 400, `${name}: ${a.status}`);
  }
});

test('changing the role of a founding member answers 200 and writes that one profile\'s role, nothing else', async () => {
  for (const target of [DRILLER, OFF, INVITED]) {
    const a = await call('PATCH', 'token-admin', { id: target, action: 'setRole', role: 'Supervisor' });
    assert.equal(a.status, 200, target);
    assert.deepEqual(a.body, { action: 'roleChanged', role: 'Supervisor' });
    assert.deepEqual(a.writes, [`write:update:profiles:id=${target}:{"role":"Supervisor"}`]);
    assert.equal(world.profiles.find((p) => p.id === target)!.role, 'Supervisor');
  }
});

test('a role outside the four is 400 and writes nothing, whoever the target is', async () => {
  for (const target of [DRILLER, OTHER_ADMIN, MISSING]) {
    for (const role of ['admin', 'Owner', '', undefined, null]) {
      const a = await call('PATCH', 'token-admin', { id: target, action: 'setRole', role });
      assert.equal(a.status, 400, `${target} ${JSON.stringify(role)}`);
      assert.deepEqual(a.writes, []);
    }
  }
});

test('deleting a founding member who has logged records bans the account instead, and deletes nothing', async () => {
  const a = await call('DELETE', 'token-admin', { id: DRILLER });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { action: 'deactivated', records: 1 });
  assert.deepEqual(a.writes, [`write:auth.updateUserById:${DRILLER}:{"ban_duration":"876000h"}`]);
});

test('deleting a founding member who has logged nothing deletes that account, and only that', async () => {
  const a = await call('DELETE', 'token-admin', { id: FRESH });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { action: 'deleted', records: 0 });
  assert.deepEqual(a.writes, [`write:auth.deleteUser:${FRESH}`]);
});

test('reactivating a founding member lifts that account\'s ban, and only that', async () => {
  const a = await call('PATCH', 'token-admin', { id: OFF, action: 'reactivate' });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { action: 'reactivated' });
  assert.deepEqual(a.writes, [`write:auth.updateUserById:${OFF}:{"ban_duration":"none"}`]);
});

test('on every allowed change the target\'s memberships are read before the first write', async () => {
  const allowed: Array<[string, string, unknown, string]> = [
    ['setRole', 'PATCH', { id: DRILLER, action: 'setRole', role: 'Supervisor' }, DRILLER],
    ['reactivate', 'PATCH', { id: OFF, action: 'reactivate' }, OFF],
    ['delete with records', 'DELETE', { id: DRILLER }, DRILLER],
    ['delete without records', 'DELETE', { id: FRESH }, FRESH],
  ];
  for (const [name, method, body, target] of allowed) {
    const a = await call(method, 'token-admin', body);
    const firstWrite = a.events.findIndex((e) => e.startsWith('write:'));
    const targetRead = a.events.findIndex((e) => e.startsWith('read:memberships:') && e.endsWith(`:user_id=${target}`));
    assert.ok(firstWrite > 0, `${name}: nothing was written`);
    assert.ok(targetRead >= 0 && targetRead < firstWrite, `${name}: ${a.events.join(' | ')}`);
  }
});

test('an unknown action and an unsupported method are refused and write nothing', async () => {
  for (const target of [DRILLER, OTHER_ADMIN, DUAL]) {
    const unknown = await call('PATCH', 'token-admin', { id: target, action: 'promote' });
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.writes, []);
    const put = await call('PUT', 'token-admin', { id: target });
    assert.equal(put.status, 405);
    assert.deepEqual(put.writes, []);
  }
});

test('no request ever writes to memberships, organizations or another account than its target', async () => {
  for (const target of [DRILLER, FRESH, OFF, INVITED, OTHER_ADMIN, DUAL, NOBODY, MISSING]) {
    for (const [name, method, body] of TARGETED(target)) {
      const a = await call(method, 'token-admin', body);
      for (const w of a.writes) {
        assert.ok(!/:(memberships|organizations):/.test(w), `${name}: ${w}`);
        assert.ok(w.includes(target), `${name} on ${target} wrote ${w}`);
      }
    }
  }
});
