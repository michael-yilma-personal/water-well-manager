import type { SupabaseClient } from '@supabase/supabase-js';

export type Organization = {
  id: string;
  name: string;
  createdAt: string;
  // Null for an organization without a subscription.
  plan: string | null;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  graceDays: number | null;
  maxUsersOverride: number | null;
  featuresOverride: Record<string, unknown> | null;
  notes: string | null;
  access: string;
  members: number;
};

export type PlatformMember = { id: string; name: string | null; email: string; role: string; status: string };

export type Plan = { id: string; name: string; maxUsers: number | null; features: Record<string, unknown> | null; isActive: boolean };

export type AuditEntry = {
  id: number;
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  orgId: string | null;
  orgName: string | null;
  action: string;
  target: string | null;
  // The target's email when the target is a user's id.
  targetEmail: string | null;
  details: unknown;
};

// `adminRole` is the application's name for an organization's administrator role.
type Deps = { getClient: () => SupabaseClient | null; fetch: typeof fetch; functionsUrl: string; apiKey: string; adminRole: string };

type Failure = { message: string; code?: string } | null;

const AUDIT_LIMIT = 200;

export type PlatformApi = ReturnType<typeof createPlatformApi>;

/** The platform administrator's client. Every refusal rejects with the server's sentence. */
export function createPlatformApi(deps: Deps) {
  function client(): SupabaseClient {
    const c = deps.getClient();
    if (!c) throw new Error('Not connected');
    return c;
  }

  function unwrap<T>({ data, error }: { data: unknown; error: Failure }): T {
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data as T;
  }

  const rpc = async <T>(fn: string, args?: Record<string, unknown>) => unwrap<T>(await client().rpc(fn, args));

  return {
    adminRole: deps.adminRole,

    // Only `true` is a yes; an error rejects.
    isPlatformAdmin: async () => (await rpc<boolean | null>('is_platform_admin')) === true,

    async listOrganizations(): Promise<Organization[]> {
      const rows = await rpc<Record<string, never>[] | null>('platform_organizations');
      return (rows ?? []).map((r) => ({
        id: r.org_id, name: r.name, createdAt: r.created_at, plan: r.plan_id, status: r.status,
        startsAt: r.starts_at, endsAt: r.ends_at, graceDays: r.grace_days,
        maxUsersOverride: r.max_users_override, featuresOverride: r.features_override,
        notes: r.notes, access: r.access, members: r.members,
      }));
    },

    async listMembers(orgId: string): Promise<PlatformMember[]> {
      const rows = await rpc<Record<string, never>[] | null>('platform_members', { p_org: orgId });
      return (rows ?? []).map((r) => ({ id: r.user_id, name: r.name, email: r.email, role: r.role, status: r.status }));
    },

    async listPlans(): Promise<Plan[]> {
      const rows = unwrap<Record<string, never>[] | null>(await client().from('plans').select('*').order('id'));
      return (rows ?? []).map((r) => ({ id: r.id, name: r.name, maxUsers: r.max_users, features: r.features, isActive: r.is_active }));
    },

    /** Newest first, at most AUDIT_LIMIT rows; for one organization when one is given. */
    async listAudit(orgId?: string): Promise<AuditEntry[]> {
      const rows = await rpc<Record<string, never>[] | null>('platform_audit', { p_org: orgId ?? null, p_limit: AUDIT_LIMIT });
      return (rows ?? []).map((r) => ({
        id: r.id, at: r.at, actorId: r.actor_id, actorEmail: r.actor_email, orgId: r.org_id, orgName: r.org_name,
        action: r.action, target: r.target, targetEmail: r.target_email, details: r.details,
      }));
    },

    /** Returns the new organization's id. */
    createOrganization: (input: { name: string; plan: string; status: string; endsAt?: string | null }) =>
      rpc<string>('platform_create_organization', {
        p_name: input.name, p_plan: input.plan, p_status: input.status, p_ends_at: input.endsAt ?? null,
      }),

    /** `args` as the database function takes them: ends_at, plan, max_users, features, notes. */
    updateSubscription: (orgId: string, action: string, args: Record<string, unknown> = {}) =>
      rpc<unknown>('platform_update_subscription', { p_org: orgId, p_action: action, p_args: args }),

    /** The organization's first administrator: 'created' with the password given, or 'invited' for an existing account. */
    async addFirstAdmin(orgId: string, input: { email: string; name: string; password: string }): Promise<{ id: string; outcome: string }> {
      const { data } = await client().auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error('Not signed in');
      const response = await deps.fetch(`${deps.functionsUrl}/saas-members`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, apikey: deps.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, ...input, role: deps.adminRole }),
      });
      // A gateway failure may answer with something that is not JSON.
      const answer = await response.json().catch(() => null);
      if (!response.ok) {
        const message = typeof answer?.error === 'string' ? answer.error : `Request failed (${response.status})`;
        throw Object.assign(new Error(message), { status: response.status });
      }
      return answer as { id: string; outcome: string };
    },
  };
}
