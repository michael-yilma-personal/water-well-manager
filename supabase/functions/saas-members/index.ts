/**
 * Member management for organization administrators: the wiring only.
 *
 * Every decision (who may call, what is refused, what is answered) is in
 * ./handler.ts. This file gives it its ports: the service-role key, which
 * must never reach a browser, stays here. It reads `memberships` and calls
 * the database's member functions; it writes no table itself.
 *
 * Needs the member migrations (saas_roles(), saas_add_member() and the
 * others) and the subscriptions migration (org_access()): deploy it after
 * them, never before.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handle, type Membership, type Ports } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY')!;
const ANON_KEY =
  Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

/** A read or an account call that failed: the handler logs it and answers 500. */
function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? 'no answer'}`);
}

async function rpc(fn: string, args?: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) fail(fn, error);
  return data;
}

async function memberships(column: 'user_id' | 'org_id', id: string): Promise<Membership[]> {
  const { data, error } = await admin
    .from('memberships')
    .select('org_id, user_id, role, status, badge_number, created_at')
    .eq(column, id);
  if (error) fail('memberships', error);
  return (data ?? []).map((m) => ({
    orgId: m.org_id, userId: m.user_id, role: m.role, status: m.status,
    badgeNumber: m.badge_number, createdAt: m.created_at,
  }));
}

// The auth server gives the accounts a page at a time and caps the page size
// itself, so the listing is read until a page comes back empty.
async function allAccounts() {
  const found = [];
  for (let page = 1; ; page += 1) {
    if (page > 400) fail('account listing', { message: 'it does not end' });
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) fail('account listing', error);
    const users = data?.users ?? [];
    if (users.length === 0) return found;
    found.push(...users);
  }
}

const ports: Ports = {
  // Who is calling is read with their own token, never the service key.
  async callerId(authorization) {
    if (!authorization?.startsWith('Bearer ')) return null;
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authorization } },
    });
    const { data, error } = await asCaller.auth.getUser();
    return error || !data?.user ? null : data.user.id;
  },

  adminRoles: async () => (await rpc('saas_admin_roles')) ?? [],
  roles: async () => (await rpc('saas_roles')) ?? [],
  membershipsOf: (userId) => memberships('user_id', userId),
  membersOf: (orgId) => memberships('org_id', orgId),

  async recordCount(orgId, userId) {
    const count = Number(await rpc('saas_member_record_count', { org: orgId, member: userId }));
    // An unknown count must never be taken for "no records".
    if (!Number.isFinite(count)) fail('record count', null);
    return count;
  },

  async accounts(ids) {
    const wanted = new Set(ids.map((id) => id.toLowerCase()));
    return (await allAccounts())
      .filter((u) => wanted.has(u.id.toLowerCase()))
      .map((u) => ({
        id: u.id,
        email: u.email ?? '',
        name: u.user_metadata?.name || u.email?.split('@')[0] || '',
        lastSignInAt: u.last_sign_in_at ?? null,
      }));
  },

  async accountIdByEmail(email) {
    const wanted = email.toLowerCase();
    // An address nobody proved they own is not an account to invite.
    return (await allAccounts())
      .find((u) => u.email_confirmed_at && u.email?.toLowerCase() === wanted)?.id ?? null;
  },

  async createAccount({ email, password, name, orgId }) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // provisioned accounts do not need to confirm
      // The marker says which organization the account is created for, so it
      // is not enrolled in another. The auth server inserts the row with
      // user_metadata only and adds app_metadata afterwards: it must be in both.
      // No empty name: without one the name falls back to the email's.
      user_metadata: name ? { name, saas_org: orgId } : { saas_org: orgId },
      app_metadata: { saas_org: orgId },
    });
    // The one refusal the handler tells apart. Older auth servers give it no code, only the message.
    if (error?.code === 'email_exists' || /already been registered/i.test(error?.message ?? '')) {
      throw Object.assign(new Error('account creation: the email is taken'), { code: 'email_exists' });
    }
    if (error || !data?.user) fail('account creation', error);
    return data.user.id;
  },

  // Anything but an answer the handler knows is no access.
  orgAccess: async (orgId) => (await rpc('org_access', { org: orgId })) ?? 'none',

  async deleteAccount(id) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) fail('account deletion', error);
  },

  async call(fn, args) {
    const { data, error } = await admin.rpc(fn, args);
    if (!error) return { data };
    // What the database said stays in the log; the handler maps the code.
    console.error(`saas-members: ${fn}:`, error.code, error.message);
    return { code: error.code ?? '' };
  },
};

Deno.serve((req) => handle(req, ports));
