// P2-2, criteria 1 to 8 and 10: the request logic of the `saas-members` edge
// function, `handle(req, ports)`, against an in-memory stand-in for its ports
// that remembers every write. Written before the handler, from the criteria in
// docs/saas/IMPLEMENTATION_STATUS.md. Role names here are the foundation's
// (`admin`, `member`); the real auth server and database are criterion 9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, type Ports } from '../../supabase/functions/saas-members/handler.ts';

const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const ORG_A = uuid('a'), ORG_B = uuid('b');
const ADMIN_A = uuid('1'), MEMBER_A = uuid('2'), INVITED_A = uuid('3'), ADMIN_B = uuid('4'), MEMBER_B = uuid('5');
const NEW_ID = uuid('9'), UNKNOWN = uuid('0');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // as PostgreSQL compares uuids

type Opts = { caller?: string | null; refuse?: string; fail?: keyof Ports; unconfirmed?: string; access?: Record<string, string> };

function world(opts: Opts = {}) {
  const accounts = [ADMIN_A, MEMBER_A, INVITED_A, ADMIN_B, MEMBER_B].map((id, i) => (
    { id, email: `user${i + 1}@example.com`, name: `User ${i + 1}`, lastSignInAt: i === 0 ? '2026-11-20T08:00:00Z' : null }));
  const row = (orgId: string, userId: string, role: string, status: string, badgeNumber: string | null = null) => (
    { orgId, userId, role, status, badgeNumber, createdAt: '2026-11-01T00:00:00Z' });
  const memberships = [
    row(ORG_A, ADMIN_A, 'admin', 'active', 'A-1'), row(ORG_A, MEMBER_A, 'member', 'deactivated'),
    row(ORG_A, INVITED_A, 'admin', 'invited'), row(ORG_B, ADMIN_B, 'admin', 'active'),
    row(ORG_B, MEMBER_B, 'member', 'active'), row(ORG_B, MEMBER_A, 'admin', 'deactivated'),
  ];
  const writes: { op: string; args: any }[] = [];
  const ports: Ports = {
    callerId: async () => (opts.caller === undefined ? ADMIN_A : opts.caller),
    adminRoles: async () => ['admin'],
    roles: async () => ['admin', 'member'],
    membershipsOf: async (userId) => memberships.filter((m) => same(m.userId, userId)),
    membersOf: async (orgId) => memberships.filter((m) => same(m.orgId, orgId)),
    recordCount: async (orgId, userId) => (same(orgId, ORG_A) && same(userId, MEMBER_A) ? 3 : 0),
    accounts: async (ids) => accounts.filter((a) => ids.some((id) => same(id, a.id))),
    accountIdByEmail: async (email) => accounts.find((a) => a.email === email.toLowerCase())?.id ?? null,
    createAccount: async (input) => {
      // An unconfirmed account holds the email: accountIdByEmail does not match it, the auth server refuses.
      if (input.email === opts.unconfirmed) {
        throw Object.assign(new Error('A user with this email address has already been registered'), { code: 'email_exists' });
      }
      writes.push({ op: 'createAccount', args: input });
      accounts.push({ id: NEW_ID, email: input.email.toLowerCase(), name: input.name, lastSignInAt: null });
      return NEW_ID;
    },
    deleteAccount: async (id) => {
      writes.push({ op: 'deleteAccount', args: id });
      accounts.splice(accounts.findIndex((a) => same(a.id, id)), 1);
    },
    call: async (fn, args: any) => {
      writes.push({ op: fn, args });
      if (opts.refuse) return { code: opts.refuse };
      if (fn === 'saas_add_member') {
        if (memberships.some((m) => same(m.orgId, args.org) && same(m.userId, args.member))) return { code: 'SM003' };
        memberships.push(row(args.org, args.member, args.role, args.status, args.badge ?? null));
      }
      return { data: fn === 'saas_remove_member' ? 'deactivated' : null };
    },
  };
  // P3-2, ASSUMED: the handler learns the organization's access level ('full', 'read_only', 'none') from this port.
  (ports as any).orgAccess = async (orgId: string) => opts.access?.[orgId.toLowerCase()] ?? 'full';
  if (opts.fail) (ports as any)[opts.fail] = async () => { throw new Error('connection refused at db.internal'); };
  const before = JSON.stringify(memberships);
  const send = async (method: string, body: Record<string, unknown> = {}, query = '') => {
    const res = await handle(new Request(`http://localhost/saas-members${query}`, {
      method, headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }), ports);
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  return { send, writes, accounts, memberships, unchanged: () => JSON.stringify(memberships) === before };
}

const newPerson = { org_id: ORG_A, email: 'new@example.com', name: 'New', role: 'member', badgeNumber: 'N-1', password: 'correct horse battery 9' };

test('a request without a valid session is answered 401 and writes nothing', async () => {
  const w = world({ caller: null });
  assert.equal((await w.send('GET', {}, `?org_id=${ORG_A}`)).status, 401);
  assert.equal((await w.send('DELETE', { org_id: ORG_A, id: MEMBER_A })).status, 401);
  assert.deepEqual(w.writes, []);
});

test('a missing or malformed organization, an unknown role, a missing password and acting on oneself are 400 with nothing written', async () => {
  const w = world();
  assert.equal((await w.send('GET')).status, 400);
  assert.equal((await w.send('GET', {}, '?org_id=not-a-uuid')).status, 400);
  assert.equal((await w.send('PATCH', { id: MEMBER_A, action: 'deactivate' })).status, 400);
  assert.equal((await w.send('POST', { ...newPerson, role: 'owner' })).status, 400);
  assert.equal((await w.send('POST', { ...newPerson, password: undefined })).status, 400);
  assert.equal((await w.send('DELETE', { org_id: ORG_A, id: ADMIN_A })).status, 400);
  assert.deepEqual(w.writes, []);
});

test('anyone who is not an active administrator of the named organization gets the same 403, whether it exists or not', async () => {
  const unknownOrg = await world().send('GET', {}, `?org_id=${uuid('c')}`);
  assert.equal(unknownOrg.status, 403);
  const refused: [string, string][] = [[MEMBER_B, ORG_B], [MEMBER_A, ORG_B], [INVITED_A, ORG_A], [ADMIN_B, ORG_A]];
  for (const [caller, org] of refused) {
    const w = world({ caller });
    assert.deepEqual(await w.send('GET', {}, `?org_id=${org}`), unknownOrg, `${caller} listing ${org}`);
    assert.deepEqual(await w.send('PATCH', { org_id: org, id: ADMIN_A, action: 'deactivate' }), unknownOrg);
    assert.deepEqual(w.writes, []);
  }
});

test('GET lists every membership of the organization, whatever its status, and nobody else', async () => {
  const { status, body } = await world().send('GET', {}, `?org_id=${ORG_A}`);
  assert.equal(status, 200);
  assert.deepEqual(body.members.map((m: any) => m.id).sort(), [ADMIN_A, MEMBER_A, INVITED_A]);
  assert.deepEqual(body.members.find((m: any) => m.id === ADMIN_A), {
    id: ADMIN_A, email: 'user1@example.com', name: 'User 1', role: 'admin', badgeNumber: 'A-1', status: 'active',
    createdAt: '2026-11-01T00:00:00Z', lastSignInAt: '2026-11-20T08:00:00Z', records: 0, isSelf: true,
  });
  const other = body.members.find((m: any) => m.id === MEMBER_A);
  assert.deepEqual([other.role, other.status, other.records, other.isSelf], ['member', 'deactivated', 3, false]);
});

test('POST with an unused email creates the account for that organization and an active membership', async () => {
  const w = world();
  assert.deepEqual(await w.send('POST', newPerson), { status: 201, body: { id: NEW_ID, outcome: 'created' } });
  assert.deepEqual(w.writes, [
    { op: 'createAccount', args: { email: newPerson.email, password: newPerson.password, name: 'New', orgId: ORG_A } },
    { op: 'saas_add_member', args: { org: ORG_A, member: NEW_ID, role: 'member', badge: 'N-1', status: 'active', actor: ADMIN_A } },
  ]);
});

test('POST with the email of an existing account, in any case, only invites it', async () => {
  const w = world();
  const res = await w.send('POST', { ...newPerson, email: 'USER5@Example.com' });
  assert.deepEqual(res, { status: 201, body: { id: MEMBER_B, outcome: 'invited' } });
  assert.deepEqual(w.writes, [
    { op: 'saas_add_member', args: { org: ORG_A, member: MEMBER_B, role: 'member', badge: 'N-1', status: 'invited', actor: ADMIN_A } },
  ]);
});

test('POST for someone who is already a member, whatever the status, is 409 and changes nothing', async () => {
  const w = world();
  assert.equal((await w.send('POST', { ...newPerson, email: 'user2@example.com' })).status, 409);
  assert.ok(w.unchanged());
  assert.deepEqual(w.writes.filter((x) => x.op !== 'saas_add_member'), []);
});

test('when the membership cannot be created, the account just created is deleted again', async () => {
  const w = world({ refuse: 'SM001' });
  assert.equal((await w.send('POST', newPerson)).status, 500);
  assert.deepEqual(w.writes.map((x) => x.op), ['createAccount', 'saas_add_member', 'deleteAccount']);
  assert.equal(w.writes[2].args, NEW_ID);
  assert.equal(w.accounts.length, 5);
  assert.ok(w.unchanged());
});

test('a target outside the organization is 404 "No such member", an unknown id and a member elsewhere alike, before any write', async () => {
  const w = world();
  const unknown = await w.send('PATCH', { org_id: ORG_A, id: UNKNOWN, action: 'setRole', role: 'admin' });
  assert.deepEqual(unknown, { status: 404, body: { error: 'No such member' } });
  assert.deepEqual(await w.send('PATCH', { org_id: ORG_A, id: MEMBER_B, action: 'setRole', role: 'admin' }), unknown);
  assert.deepEqual(await w.send('DELETE', { org_id: ORG_A, id: MEMBER_B }), unknown);
  assert.deepEqual(w.writes, []);
});

test('an administrator of one organization changes nothing in another, by naming it or by naming its member', async () => {
  const w = world();
  assert.equal((await w.send('GET', {}, `?org_id=${ORG_B}`)).status, 403);
  assert.equal((await w.send('POST', { ...newPerson, org_id: ORG_B })).status, 403);
  for (const action of ['setRole', 'setBadge', 'deactivate', 'reactivate']) {
    const change = { id: MEMBER_B, action, role: 'admin', badgeNumber: 'X' };
    assert.equal((await w.send('PATCH', { org_id: ORG_B, ...change })).status, 403, action);
    assert.equal((await w.send('PATCH', { org_id: ORG_A, ...change })).status, 404, action);
  }
  assert.equal((await w.send('DELETE', { org_id: ORG_B, id: MEMBER_B })).status, 403);
  assert.deepEqual(w.writes, []);
  assert.ok(w.unchanged());
});

test('a member who also belongs elsewhere is managed in the named organization only, through the member functions', async () => {
  const w = world();
  assert.equal((await w.send('PATCH', { org_id: ORG_A, id: MEMBER_A, action: 'setRole', role: 'admin' })).status, 200);
  assert.deepEqual(await w.send('DELETE', { org_id: ORG_A, id: MEMBER_A }), { status: 200, body: { action: 'deactivated', records: 3 } });
  assert.deepEqual(w.writes, [
    { op: 'saas_set_member_role', args: { org: ORG_A, member: MEMBER_A, role: 'admin', actor: ADMIN_A } },
    { op: 'saas_remove_member', args: { org: ORG_A, member: MEMBER_A, actor: ADMIN_A } },
  ]);
});

test('a refusal of a member function is mapped by its code; an unknown code and a failed read give the same fixed 500', async () => {
  const change = { org_id: ORG_A, id: MEMBER_A, action: 'reactivate' };
  const expected = { SM002: 400, SM008: 400, SM005: 400, SM003: 409, SM006: 409, SM007: 409, SM004: 404 };
  for (const [code, status] of Object.entries(expected)) {
    const res = await world({ refuse: code }).send('PATCH', change);
    assert.equal(res.status, status, code);
    assert.equal(typeof res.body.error, 'string', code);
    if (code === 'SM004') assert.equal(res.body.error, 'No such member');
  }
  const unmapped = await world({ refuse: '23505' }).send('PATCH', change);
  assert.equal(unmapped.status, 500);
  for (const fail of ['membershipsOf', 'accountIdByEmail', 'membersOf'] as const) {
    const w = world({ fail });
    assert.deepEqual(await w.send(fail === 'membersOf' ? 'GET' : 'POST', newPerson, fail === 'membersOf' ? `?org_id=${ORG_A}` : ''), unmapped, fail);
    assert.deepEqual(w.writes, [], fail);
  }
  assert.doesNotMatch(JSON.stringify(unmapped.body), /23505|connection refused/);
});

test('ids are compared without regard to case: an upper-case organization is the caller\'s own, an upper-case own id is oneself', async () => {
  const w = world();
  assert.equal((await w.send('GET', {}, `?org_id=${ORG_A.toUpperCase()}`)).status, 200);
  assert.equal((await w.send('PATCH', { org_id: ORG_A.toUpperCase(), id: ADMIN_A.toUpperCase(), action: 'deactivate' })).status, 400);
  assert.equal((await w.send('DELETE', { org_id: ORG_A, id: ADMIN_A.toUpperCase() })).status, 400);
  assert.deepEqual(w.writes, []);
});

test('a member may change their own badge, through saas_set_member_badge; their own role is still 400', async () => {
  const w = world();
  assert.equal((await w.send('PATCH', { org_id: ORG_A, id: ADMIN_A, action: 'setRole', role: 'member' })).status, 400);
  assert.deepEqual(w.writes, []);
  assert.equal((await w.send('PATCH', { org_id: ORG_A, id: ADMIN_A, action: 'setBadge', badgeNumber: 'A-2' })).status, 200);
  assert.deepEqual(w.writes, [
    { op: 'saas_set_member_badge', args: { org: ORG_A, member: ADMIN_A, badge: 'A-2', actor: ADMIN_A } },
  ]);
});

test('the list shows neither the name nor the last sign-in of a person who is only invited (RF-110)', async () => {
  const w = world();
  w.accounts.find((a) => a.id === INVITED_A)!.lastSignInAt = '2026-11-21T09:00:00Z';
  const { body } = await w.send('GET', {}, `?org_id=${ORG_A}`);
  const invited = body.members.find((m: any) => m.id === INVITED_A);
  assert.deepEqual([invited.status, invited.name, invited.lastSignInAt], ['invited', '', null]);
});

test('POST with an email that is not shaped x@y is 400 and nothing is created (RF-112)', async () => {
  const w = world();
  for (const email of ['nobody', '@example.com', 'nobody@', 'a b@example.com']) {
    assert.equal((await w.send('POST', { ...newPerson, email })).status, 400, email);
  }
  assert.deepEqual(w.writes, []);
});

test('POST with an email held by an unconfirmed account is 409 with a fixed message; nothing is created and nobody invited (RF-118)', async () => {
  const w = world({ unconfirmed: newPerson.email });
  const res = await w.send('POST', newPerson);
  assert.equal(res.status, 409);
  assert.equal(typeof res.body.error, 'string');
  assert.doesNotMatch(JSON.stringify(res.body), /new@example\.com|confirm|registered|email_exists/i);
  assert.deepEqual(w.writes, []);
  assert.equal(w.accounts.length, 5);
  assert.ok(w.unchanged());
  assert.equal((await world({ fail: 'createAccount' }).send('POST', newPerson)).status, 500, 'any other failure stays 500');
});

// P3-2, criteria 6 and 7. ASSUMED: a refusal for the subscription is HTTP 402 with a one-sentence
// message; someone who is not an administrator still gets the 403, whatever the subscription.
const refused402 = (res: { status: number; body: any }, what: string) => {
  assert.equal(res.status, 402, what);
  assert.match(res.body.error, /^[^.!?]+[.!?]?$/, what);
};

test('expired (read_only): the list and deactivating a member work; adding, inviting, re-activating and changing a role or badge are 402 and write nothing', async () => {
  const w = world({ access: { [ORG_A]: 'read_only' } });
  const change = { org_id: ORG_A, id: MEMBER_A };
  refused402(await w.send('POST', newPerson), 'add');
  refused402(await w.send('POST', { ...newPerson, email: 'user5@example.com' }), 'invite');
  refused402(await w.send('PATCH', { ...change, action: 'reactivate' }), 'reactivate');
  refused402(await w.send('PATCH', { ...change, action: 'setRole', role: 'admin' }), 'setRole');
  refused402(await w.send('PATCH', { ...change, action: 'setBadge', badgeNumber: 'X' }), 'setBadge');
  assert.deepEqual(w.writes, []);
  assert.equal((await w.send('GET', {}, `?org_id=${ORG_A}`)).status, 200);
  w.memberships.find((m) => m.orgId === ORG_A && m.userId === MEMBER_A)!.status = 'active';
  assert.equal((await w.send('PATCH', { ...change, action: 'deactivate' })).status, 200);
  assert.deepEqual(w.writes.map((x) => [x.op, x.args.status]), [['saas_set_member_status', 'deactivated']]);
});

test('suspended or canceled (none): everything is 402, the list included; another organization is not affected and a non-administrator still gets 403', async () => {
  const access = { [ORG_A]: 'none' };
  const w = world({ access });
  refused402(await w.send('GET', {}, `?org_id=${ORG_A}`), 'list');
  refused402(await w.send('POST', newPerson), 'add');
  refused402(await w.send('PATCH', { org_id: ORG_A, id: MEMBER_A, action: 'deactivate' }), 'deactivate');
  refused402(await w.send('DELETE', { org_id: ORG_A, id: MEMBER_A }), 'remove');
  assert.deepEqual(w.writes, []);
  const other = world({ caller: ADMIN_B, access });
  assert.equal((await other.send('GET', {}, `?org_id=${ORG_B}`)).status, 200);
  assert.equal((await other.send('GET', {}, `?org_id=${ORG_A}`)).status, 403);
});

test('the user-limit refusal (SS001) is 409 with a message that says the user limit is reached; the account just created is deleted again', async () => {
  const w = world({ refuse: 'SS001' });
  const res = await w.send('POST', newPerson);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /user limit/i);
  assert.equal(w.accounts.length, 5);
  assert.equal((await w.send('PATCH', { org_id: ORG_A, id: MEMBER_A, action: 'reactivate' })).status, 409);
});

test('the function is reusable: neither source file names a Drill table, role or bucket', () => {
  const words = ['profiles', 'boreholes', 'pipe_records', 'drilling_events', 'shift_logs', 'Driller', 'Data Logger', 'Supervisor', 'Administrator', 'drilling-photos'];
  for (const file of ['handler.ts', 'index.ts']) {
    const source = readFileSync(new URL(`../../supabase/functions/saas-members/${file}`, import.meta.url), 'utf8');
    for (const word of words) assert.ok(!source.includes(word), `${file} names ${word}`);
  }
});
