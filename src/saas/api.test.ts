import assert from 'node:assert/strict';
import test from 'node:test';
import { createSaasApi } from './api';

const ORG = 'aaaaaaaa-0000-0000-0000-000000000001';
const MEMBER = 'bbbbbbbb-0000-0000-0000-000000000002';
const FUNCTIONS_URL = 'https://functions.test/functions/v1';

type Options = { session?: boolean; client?: boolean; rpc?: { data: unknown; error: unknown }; status?: number; body?: unknown };

function setup(o: Options = {}) {
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const requests: { url: URL; method: string; headers: Headers; body: Record<string, unknown> | null }[] = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: o.session === false ? null : { access_token: 'token-1' } }, error: null }),
    },
    rpc: async (fn: string, args?: unknown) => {
      rpcCalls.push({ fn, args });
      return o.rpc ?? { data: null, error: null };
    },
  };
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    requests.push({
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    const text = typeof o.body === 'string' ? o.body : JSON.stringify(o.body ?? {});
    return new Response(text, { status: o.status ?? 200 });
  };
  const api = createSaasApi({
    getClient: () => (o.client === false ? null : (client as never)),
    fetch: fetchStub as typeof fetch,
    functionsUrl: FUNCTIONS_URL,
    apiKey: 'anon-key',
  });
  return { api, rpcCalls, requests };
}

test('fetchMyOrganizations returns the rows of my_organizations() as orgId, name, role, status', async () => {
  // The row shape since P3-1: access and ends_at are always present, null for a membership that is not active.
  const rows = [{ org_id: ORG, name: 'Acme', role: 'admin', status: 'invited', access: null, ends_at: null }];
  const { api, rpcCalls } = setup({ rpc: { data: rows, error: null } });
  assert.deepEqual(await api.fetchMyOrganizations(), [{ orgId: ORG, name: 'Acme', role: 'admin', status: 'invited', access: null, endsAt: null }]);
  assert.equal(rpcCalls[0].fn, 'my_organizations');
});

// P3-3 (D3-8). Assumed: Membership gains access ('full' | 'read_only' | 'none' | null) and endsAt (string | null).
test('fetchMyOrganizations carries the access level and end date of each organization', async () => {
  const rows = [
    { org_id: ORG, name: 'Acme', role: 'admin', status: 'active', access: 'read_only', ends_at: '2026-11-20T00:00:00+00:00' },
    { org_id: MEMBER, name: 'Other', role: 'member', status: 'invited', access: null, ends_at: null },
  ];
  const { api } = setup({ rpc: { data: rows, error: null } });
  const got = (await api.fetchMyOrganizations()) as unknown as { access: unknown; endsAt: unknown }[];
  assert.deepEqual(got.map((m) => [m.access ?? null, m.endsAt ?? null]), [['read_only', '2026-11-20T00:00:00+00:00'], [null, null]]);
});

test('accepting and declining call the invitation functions with the organization given', async () => {
  const { api, rpcCalls } = setup();
  await api.acceptMembership(ORG);
  await api.declineMembership(ORG);
  assert.deepEqual(rpcCalls, [
    { fn: 'accept_membership', args: { org: ORG } },
    { fn: 'decline_membership', args: { org: ORG } },
  ]);
});

test('a refusal by the database is not swallowed', async () => {
  const { api } = setup({ rpc: { data: null, error: { code: '42501', message: 'no invitation' } } });
  await assert.rejects(api.acceptMembership(ORG), /no invitation/);
  await assert.rejects(api.fetchMyOrganizations());
});

test('listMembers asks saas-members for that organization with the session token and returns its members unchanged', async () => {
  const members = [{ id: MEMBER, email: 'a@example.com', badgeNumber: 'B-7', status: 'active', records: 3, isSelf: false }];
  const { api, requests } = setup({ body: { members } });
  assert.deepEqual(await api.listMembers(ORG), members);
  assert.equal(requests.length, 1);
  const [r] = requests;
  assert.equal(r.method, 'GET');
  assert.equal(r.url.origin + r.url.pathname, `${FUNCTIONS_URL}/saas-members`);
  assert.equal(r.url.searchParams.get('org_id'), ORG);
  assert.equal(r.headers.get('authorization'), 'Bearer token-1');
  assert.equal(r.headers.get('apikey'), 'anon-key');
});

test('addMember posts the person with the organization and returns the id and outcome', async () => {
  const { api, requests } = setup({ status: 201, body: { id: MEMBER, outcome: 'invited' } });
  const input = { email: 'a@example.com', name: 'A', role: 'member', badgeNumber: 'B-7', password: 'long-enough-1' };
  assert.deepEqual(await api.addMember(ORG, input), { id: MEMBER, outcome: 'invited' });
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer token-1');
  assert.deepEqual(requests[0].body, { org_id: ORG, ...input });
});

test('role, badge, deactivate and reactivate each patch the member in the organization given', async () => {
  const { api, requests } = setup();
  await api.setMemberRole(ORG, MEMBER, 'admin');
  await api.setMemberBadge(ORG, MEMBER, 'B-9');
  await api.deactivateMember(ORG, MEMBER);
  await api.reactivateMember(ORG, MEMBER);
  assert.deepEqual(requests.map((r) => r.method), ['PATCH', 'PATCH', 'PATCH', 'PATCH']);
  assert.deepEqual(requests.map((r) => r.body), [
    { org_id: ORG, id: MEMBER, action: 'setRole', role: 'admin' },
    { org_id: ORG, id: MEMBER, action: 'setBadge', badgeNumber: 'B-9' },
    { org_id: ORG, id: MEMBER, action: 'deactivate' },
    { org_id: ORG, id: MEMBER, action: 'reactivate' },
  ]);
});

test('removeMember deletes in the organization given and says what happened', async () => {
  const { api, requests } = setup({ body: { action: 'deactivated', records: 4 } });
  assert.deepEqual(await api.removeMember(ORG, MEMBER), { action: 'deactivated', records: 4 });
  assert.equal(requests[0].method, 'DELETE');
  assert.deepEqual(requests[0].body, { org_id: ORG, id: MEMBER });
});

test('a non-2xx answer rejects with the function message and the status', async () => {
  const refused = setup({ status: 403, body: { error: 'Not allowed' } });
  await assert.rejects(refused.api.listMembers(ORG), (e: Error & { status?: number }) => e instanceof Error && e.message === 'Not allowed' && e.status === 403);
  const broken = setup({ status: 502, body: '<html>Bad gateway</html>' });
  await assert.rejects(broken.api.removeMember(ORG, MEMBER), (e: Error & { status?: number }) => e instanceof Error && e.message.length > 0 && e.status === 502);
});

test('without a session or a client nothing is sent', async () => {
  for (const o of [{ session: false }, { client: false }]) {
    const { api, requests } = setup(o);
    await assert.rejects(api.listMembers(ORG));
    await assert.rejects(api.deactivateMember(ORG, MEMBER));
    assert.equal(requests.length, 0);
  }
});
