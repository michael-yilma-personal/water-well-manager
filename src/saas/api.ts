import type { SupabaseClient } from '@supabase/supabase-js';

type MembershipStatus = 'invited' | 'active' | 'deactivated';

export type Membership = { orgId: string; name: string; role: string; status: MembershipStatus };

export type Member = {
  id: string;
  email: string;
  name: string;
  role: string;
  badgeNumber: string | null;
  status: MembershipStatus;
  createdAt: string;
  lastSignInAt: string | null;
  records: number;
  isSelf: boolean;
};

type MemberInput = { email: string; name: string; role: string; badgeNumber?: string; password?: string };

type Deps = { getClient: () => SupabaseClient | null; fetch: typeof fetch; functionsUrl: string; apiKey: string };

export function createSaasApi(deps: Deps) {
  function client(): SupabaseClient {
    const c = deps.getClient();
    if (!c) throw new Error('Not connected');
    return c;
  }

  async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await client().rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  }

  // The organization travels with every request: in the query on GET, in the body otherwise.
  async function members<T>(method: string, orgId: string, body?: Record<string, unknown>): Promise<T> {
    const { data } = await client().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('Not signed in');
    const get = method === 'GET';
    const url = `${deps.functionsUrl}/saas-members${get ? `?org_id=${encodeURIComponent(orgId)}` : ''}`;
    const response = await deps.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, apikey: deps.apiKey, 'Content-Type': 'application/json' },
      body: get ? undefined : JSON.stringify({ org_id: orgId, ...body }),
    });
    // A gateway failure may answer with something that is not JSON.
    const answer = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof answer?.error === 'string' ? answer.error : `Request failed (${response.status})`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return answer as T;
  }

  const patch = (orgId: string, id: string, action: string, extra?: Record<string, unknown>) =>
    members<unknown>('PATCH', orgId, { id, action, ...extra });

  return {
    async fetchMyOrganizations(): Promise<Membership[]> {
      const rows = await rpc<{ org_id: string; name: string; role: string; status: MembershipStatus }[] | null>('my_organizations');
      return (rows ?? []).map((r) => ({ orgId: r.org_id, name: r.name, role: r.role, status: r.status }));
    },
    acceptMembership: (orgId: string) => rpc<unknown>('accept_membership', { org: orgId }),
    declineMembership: (orgId: string) => rpc<unknown>('decline_membership', { org: orgId }),
    listMembers: async (orgId: string) => (await members<{ members: Member[] }>('GET', orgId)).members,
    addMember: (orgId: string, input: MemberInput) =>
      members<{ id: string; outcome: 'created' | 'invited' }>('POST', orgId, input),
    setMemberRole: (orgId: string, id: string, role: string) => patch(orgId, id, 'setRole', { role }),
    setMemberBadge: (orgId: string, id: string, badgeNumber: string) => patch(orgId, id, 'setBadge', { badgeNumber }),
    deactivateMember: (orgId: string, id: string) => patch(orgId, id, 'deactivate'),
    reactivateMember: (orgId: string, id: string) => patch(orgId, id, 'reactivate'),
    removeMember: (orgId: string, id: string) =>
      members<{ action: 'removed' | 'deactivated'; records: number }>('DELETE', orgId, { id }),
  };
}
