import assert from 'node:assert/strict';
import test from 'node:test';

// P4-3, written before the module. Assumed, in src/platform/api.ts (built like src/saas/api.ts):
//   createPlatformApi(deps: Deps): Api
// `adminRole` is the application's administrator role: configuration, never a name inside src/platform.
type Deps = { getClient: () => unknown; fetch: typeof fetch; functionsUrl: string; apiKey: string; adminRole: string };
type Api = {
  isPlatformAdmin(): Promise<boolean>;
  listOrganizations(): Promise<unknown[]>; // id, name, createdAt, plan, status, startsAt, endsAt, graceDays, maxUsersOverride, featuresOverride, notes, access, members
  listMembers(orgId: string): Promise<unknown[]>; // id, name, email, role, status
  listPlans(): Promise<unknown[]>; // id, name, maxUsers, features, isActive
  listAudit(orgId?: string): Promise<unknown[]>; // id, at, actorId, orgId, action, target, details
  createOrganization(input: { name: string; plan: string; status: string; endsAt?: string | null }): Promise<string>;
  updateSubscription(orgId: string, action: string, args?: Record<string, unknown>): Promise<unknown>; // args as the function takes them (ends_at, plan, max_users, features, notes)
  addAdministrator(orgId: string, input: { email: string; name: string; password: string }): Promise<{ id: string; outcome: string }>;
};

const ORG = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER = 'bbbbbbbb-0000-0000-0000-000000000002';
const FUNCTIONS_URL = 'https://functions.test/functions/v1';
const DENIED = { data: null, error: { code: '42501', message: 'Platform administrators only.' } };

type Result = { data: unknown; error: unknown };
type Options = { client?: boolean; rpc?: Result; table?: Result; status?: number; body?: unknown };

// The specifier is computed so that the type check passes before the module exists.
async function setup(o: Options = {}) {
  const { createPlatformApi } = (await import(['.', 'api'].join('/'))) as { createPlatformApi: (deps: Deps) => Api };
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const queries: { table: string; calls: unknown[][] }[] = [];
  const requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const client = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'token-1' } }, error: null }) },
    rpc: async (fn: string, args?: unknown) => {
      rpcCalls.push({ fn, args });
      return o.rpc ?? { data: null, error: null };
    },
    // A query builder: every method is recorded and chains; awaiting it gives the result.
    from: (table: string) => {
      const calls: unknown[][] = [];
      queries.push({ table, calls });
      const q: unknown = new Proxy({}, {
        get: (_, key) => key === 'then'
          ? (ok: (r: Result) => unknown, no: (e: unknown) => unknown) => Promise.resolve(o.table ?? { data: [], error: null }).then(ok, no)
          : (...args: unknown[]) => { calls.push([key, ...args]); return q; },
      });
      return q;
    },
  };
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    requests.push({ url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(o.body ?? {}), { status: o.status ?? 200 });
  };
  const api = createPlatformApi({
    getClient: () => (o.client === false ? null : client),
    fetch: fetchStub as typeof fetch,
    functionsUrl: FUNCTIONS_URL,
    apiKey: 'anon-key',
    adminRole: 'app-admin-role',
  });
  return { api, rpcCalls, queries, requests };
}

test('isPlatformAdmin is the answer of is_platform_admin(), and an error or no connection is never a yes', async () => {
  const yes = await setup({ rpc: { data: true, error: null } });
  assert.equal(await yes.api.isPlatformAdmin(), true);
  assert.equal(yes.rpcCalls[0].fn, 'is_platform_admin');
  for (const data of [false, null]) assert.equal(await (await setup({ rpc: { data, error: null } })).api.isPlatformAdmin(), false);
  await assert.rejects((await setup({ rpc: { data: true, error: { code: 'XX000', message: 'boom' } } })).api.isPlatformAdmin(), /boom/);
  await assert.rejects((await setup({ client: false })).api.isPlatformAdmin());
});

test('listOrganizations returns the rows of platform_organizations() in camelCase, nulls kept for an organization without a subscription', async () => {
  const rows = [
    { org_id: ORG, name: 'Acme', created_at: '2026-11-01T00:00:00+00:00', plan_id: 'basic', status: 'trial', starts_at: '2026-11-01T00:00:00+00:00',
      ends_at: '2026-12-01T00:00:00+00:00', grace_days: 7, max_users_override: 12, features_override: { x: true }, notes: 'call back', access: 'full', members: 3 },
    { org_id: USER, name: 'Bare', created_at: '2026-11-02T00:00:00+00:00', plan_id: null, status: null, starts_at: null,
      ends_at: null, grace_days: null, max_users_override: null, features_override: null, notes: null, access: 'none', members: 0 },
  ];
  const { api, rpcCalls } = await setup({ rpc: { data: rows, error: null } });
  assert.deepEqual(await api.listOrganizations(), [
    { id: ORG, name: 'Acme', createdAt: '2026-11-01T00:00:00+00:00', plan: 'basic', status: 'trial', startsAt: '2026-11-01T00:00:00+00:00',
      endsAt: '2026-12-01T00:00:00+00:00', graceDays: 7, maxUsersOverride: 12, featuresOverride: { x: true }, notes: 'call back', access: 'full', members: 3 },
    { id: USER, name: 'Bare', createdAt: '2026-11-02T00:00:00+00:00', plan: null, status: null, startsAt: null,
      endsAt: null, graceDays: null, maxUsersOverride: null, featuresOverride: null, notes: null, access: 'none', members: 0 },
  ]);
  assert.equal(rpcCalls[0].fn, 'platform_organizations');
});

test('listMembers asks platform_members for the organization given and returns id, name, email, role, status', async () => {
  const rows = [{ user_id: USER, name: null, email: 'a@example.com', role: 'some-role', status: 'invited' }];
  const { api, rpcCalls } = await setup({ rpc: { data: rows, error: null } });
  assert.deepEqual(await api.listMembers(ORG), [{ id: USER, name: null, email: 'a@example.com', role: 'some-role', status: 'invited' }]);
  assert.deepEqual(rpcCalls, [{ fn: 'platform_members', args: { p_org: ORG } }]);
});

test('listPlans reads the plans table in camelCase', async () => {
  const rows = [{ id: 'basic', name: 'Basic', max_users: 5, features: { x: true }, is_active: true }];
  const { api, queries } = await setup({ table: { data: rows, error: null } });
  assert.deepEqual(await api.listPlans(), [{ id: 'basic', name: 'Basic', maxUsers: 5, features: { x: true }, isActive: true }]);
  assert.deepEqual(queries.map((q) => q.table), ['plans']);
});

test('listAudit reads audit_log newest first with a limit, for one organization only when one is given', async () => {
  const rows = [{ id: 9, at: '2026-11-25T10:00:00+00:00', actor_id: USER, org_id: ORG, action: 'org.create', target: null, details: { plan: 'basic' } }];
  const { api, queries } = await setup({ table: { data: rows, error: null } });
  assert.deepEqual(await api.listAudit(), [{ id: 9, at: '2026-11-25T10:00:00+00:00', actorId: USER, orgId: ORG, action: 'org.create', target: null, details: { plan: 'basic' } }]);
  await api.listAudit(ORG);
  assert.deepEqual(queries.map((q) => q.table), ['audit_log', 'audit_log']);
  for (const { calls } of queries) {
    const order = calls.find(([m]) => m === 'order') as [string, string, { ascending?: boolean }] | undefined;
    assert.ok(order && ['at', 'id'].includes(order[1]) && order[2]?.ascending === false, 'newest first');
    const limit = calls.find(([m]) => m === 'limit')?.[1] as number | undefined;
    assert.ok(typeof limit === 'number' && limit >= 1 && limit <= 1000, 'a limit between 1 and 1000');
  }
  const filters = queries.map(({ calls }) => calls.filter(([m]) => m === 'eq'));
  assert.deepEqual(filters, [[], [['eq', 'org_id', ORG]]]);
});

test('createOrganization calls platform_create_organization and returns the new id; no end date is sent as null', async () => {
  const { api, rpcCalls } = await setup({ rpc: { data: ORG, error: null } });
  assert.equal(await api.createOrganization({ name: 'Acme', plan: 'basic', status: 'trial', endsAt: '2026-12-01T00:00:00Z' }), ORG);
  await api.createOrganization({ name: 'Bare', plan: 'basic', status: 'active' });
  assert.deepEqual(rpcCalls.map((c) => ({ fn: c.fn, args: { p_ends_at: null, ...(c.args as object) } })), [
    { fn: 'platform_create_organization', args: { p_ends_at: '2026-12-01T00:00:00Z', p_name: 'Acme', p_plan: 'basic', p_status: 'trial' } },
    { fn: 'platform_create_organization', args: { p_ends_at: null, p_name: 'Bare', p_plan: 'basic', p_status: 'active' } },
  ]);
});

test('updateSubscription passes the organization, the action and the arguments unchanged', async () => {
  const { api, rpcCalls } = await setup();
  await api.updateSubscription(ORG, 'override', { max_users: null, notes: 'agreed by phone' });
  await api.updateSubscription(ORG, 'suspend');
  assert.deepEqual(rpcCalls.map((c) => ({ fn: c.fn, args: { p_args: {}, ...(c.args as object) } })), [
    { fn: 'platform_update_subscription', args: { p_args: { max_users: null, notes: 'agreed by phone' }, p_org: ORG, p_action: 'override' } },
    { fn: 'platform_update_subscription', args: { p_args: {}, p_org: ORG, p_action: 'suspend' } },
  ]);
});

test('a refusal by the database rejects every call with the server message, and a list is never returned empty instead', async () => {
  const { api } = await setup({ rpc: DENIED, table: DENIED });
  const calls = [
    () => api.listOrganizations(), () => api.listMembers(ORG), () => api.listPlans(), () => api.listAudit(),
    () => api.createOrganization({ name: 'Acme', plan: 'basic', status: 'trial' }), () => api.updateSubscription(ORG, 'extend', {}),
  ];
  for (const call of calls) await assert.rejects(call(), /Platform administrators only\./);
});

test('addAdministrator posts the person to saas-members with the configured administrator role and the session token', async () => {
  const { api, requests } = await setup({ status: 201, body: { id: USER, outcome: 'created' } });
  const person = { email: 'a@example.com', name: 'A', password: 'long-enough-1' };
  assert.deepEqual(await api.addAdministrator(ORG, person), { id: USER, outcome: 'created' });
  assert.equal(requests.length, 1);
  const [r] = requests;
  assert.equal(r.method, 'POST');
  assert.equal(r.url, `${FUNCTIONS_URL}/saas-members`);
  assert.equal(r.headers.get('authorization'), 'Bearer token-1');
  assert.equal(r.headers.get('apikey'), 'anon-key');
  assert.deepEqual(r.body, { org_id: ORG, ...person, role: 'app-admin-role' });
});

test('addAdministrator rejects a non-2xx answer with the function sentence and the status', async () => {
  for (const [status, error] of [[402, 'The subscription does not allow changes'], [409, 'The user limit is reached']] as const) {
    const { api } = await setup({ status, body: { error } });
    await assert.rejects(api.addAdministrator(ORG, { email: 'a@example.com', name: 'A', password: 'long-enough-1' }),
      (e: Error & { status?: number }) => e instanceof Error && e.message === error && e.status === status);
  }
});
