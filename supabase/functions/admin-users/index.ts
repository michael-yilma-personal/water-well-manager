/**
 * Crew management for administrators.
 *
 * Creating and removing accounts needs the service-role key, which must never
 * reach a browser - anyone opening DevTools would have unrestricted access to
 * the whole database. So the key stays here, on the server, and this function
 * is the only thing that uses it.
 *
 * Every request is checked twice: the caller must present a valid session, and
 * that account must hold an active Administrator membership in the founding
 * organization (profiles.role is not consulted). The service-role client
 * bypasses Row Level Security by design, so the check is the only thing
 * standing between a driller's token and everyone else's accounts.
 *
 * This is the crew function of the FOUNDING organization and of nothing else.
 * It lists, re-roles, bans and deletes only accounts that are members of it,
 * and refuses one that also belongs to another organization: a ban or a
 * deletion acts on the whole account. The decisions are in ./policy.ts.
 *
 * It follows the founding organization's subscription like saas-members:
 * expired (read-only access), only listing and removing or deactivating;
 * suspended or canceled, nothing. The answer is then 402.
 *
 * Needs the tenancy migrations (memberships, founding_org_id()) and the
 * subscriptions migration (org_access()): deploy it after them, never before.
 *
 * Deletion is deliberately not always a delete. A driller who has logged pipe
 * records is deactivated rather than removed: their rows carry created_by, and
 * erasing the account would destroy the record of who drilled. Only an account
 * that has never logged anything is deleted outright.
 *
 * A read that fails (the founding organization, memberships, the account
 * listing, profiles, record counts) always ends the request with 500 and one
 * fixed message, before anything is written. What the database or the auth
 * server said goes to the function's log and never to the caller: it names
 * tables and rows, and the first of these reads happen before the caller is
 * authorised.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { callerMayAdminister, targetDecision, type Membership } from './policy.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

const ROLES = ['Driller', 'Data Logger', 'Supervisor', 'Administrator'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY')!;
const ANON_KEY =
  Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;

type Admin = ReturnType<typeof createClient>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An id as this function compares it. PostgreSQL takes a uuid in any case for
 * the same id, so two spellings of one id must not look like two accounts.
 */
const normalId = (id: string) => id.toLowerCase();

const LOOKUP_FAILED = 'Something went wrong on the server. Please try again.';

/** A read that failed. Carries what failed for the log; the caller gets LOOKUP_FAILED. */
class LookupError extends Error {
  constructor(what: string, cause: unknown) {
    const said = (cause as { message?: unknown } | null)?.message;
    super(`${what}: ${typeof said === 'string' ? said : String(cause)}`);
  }
}

/** 500 with the fixed message; the cause is logged, never sent. */
function lookupFailed(err: unknown) {
  console.error('admin-users:', err instanceof Error ? err.message : String(err));
  return json({ error: LOOKUP_FAILED }, 500);
}

/** The founding organization's id, or null when there is none. Throws when it cannot be read. */
async function foundingOrgId(admin: Admin): Promise<string | null> {
  const { data, error } = await admin.rpc('founding_org_id');
  if (error) throw new LookupError('founding organization', error);
  return typeof data === 'string' && data ? data : null;
}

/** Every membership of one account, in any organization. Throws when they cannot be read. */
async function membershipsOf(admin: Admin, userId: string): Promise<Membership[]> {
  const { data, error } = await admin
    .from('memberships')
    .select('org_id, role, status')
    .eq('user_id', userId);
  if (error) throw new LookupError('memberships of an account', error);
  return (data ?? []).map((m) => ({ orgId: m.org_id, role: m.role, status: m.status }));
}

/**
 * Null when this function may act on the account; otherwise the refusal.
 * An id that is no account, one that is not even an id, and an account of
 * another organization all get the same 404.
 */
async function refuseTarget(admin: Admin, founding: string, id: unknown) {
  const notFound = () => json({ error: 'No such account' }, 404);
  if (typeof id !== 'string' || !UUID.test(id)) return notFound();

  const decision = targetDecision(founding, await membershipsOf(admin, normalId(id)));
  if (decision === 'not-found') return notFound();
  if (decision === 'other-organization') {
    return json(
      { error: 'This account also belongs to another organization and cannot be managed here' },
      409,
    );
  }
  return null;
}

/** True when the id a request sent is the caller's own, in any spelling. */
function isCaller(sent: unknown, callerId: string) {
  return typeof sent === 'string' && normalId(sent) === callerId;
}

/** Resolve the caller and confirm they administer the founding organization. */
async function requireAdmin(req: Request) {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return { error: json({ error: 'Not signed in' }, 401) };
  }

  // Read the caller's identity with their own token, never the service key.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData?.user) {
    return { error: json({ error: 'Session is not valid' }, 401) };
  }

  // The token above only says who is calling. What they may do is read with
  // the service role, from memberships.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const callerId = normalId(userData.user.id);
  let founding: string | null;
  let allowed: boolean;
  try {
    founding = await foundingOrgId(admin);
    allowed = callerMayAdminister(founding, await membershipsOf(admin, callerId));
  } catch (err) {
    return { error: lookupFailed(err) };
  }
  // `allowed` is the decision; it is never true without a founding
  // organization, and the second test only tells the compiler so.
  if (!allowed || !founding) {
    return { error: json({ error: 'Administrators only' }, 403) };
  }
  return { admin, callerId, founding };
}

/**
 * How many drilling rows an account authored, across every table: in one
 * organization, or everywhere when none is given. Throws when a table cannot
 * be counted, so that an unknown count is never taken for "no records".
 */
async function recordCounts(admin: Admin, userId: string, orgId?: string) {
  const tables = ['boreholes', 'pipe_records', 'drilling_events', 'shift_logs'];
  let total = 0;
  for (const t of tables) {
    let query = admin.from(t).select('id', { count: 'exact', head: true }).eq('created_by', userId);
    if (orgId) query = query.eq('org_id', orgId);
    const { count, error } = await query;
    if (error || typeof count !== 'number') throw new LookupError(`record count of ${t}`, error ?? 'no count');
    total += count;
  }
  return total;
}

// The auth server gives the accounts a page at a time and caps the page size
// itself, so the listing is read until a page comes back empty.
const ACCOUNTS_PER_PAGE = 1000;
const ACCOUNT_PAGES_AT_MOST = 400;

/** Every account of the project for which `wanted` is true. Throws when a page cannot be read. */
async function listAccounts(admin: Admin, wanted: (id: string) => boolean) {
  const found = [];
  for (let page = 1; ; page += 1) {
    if (page > ACCOUNT_PAGES_AT_MOST) throw new LookupError('account listing', 'it does not end');
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: ACCOUNTS_PER_PAGE });
    if (error) throw new LookupError('account listing', error);
    const users = data?.users ?? [];
    if (users.length === 0) return found;
    for (const u of users) if (wanted(normalId(u.id))) found.push(u);
  }
}

// Ids travel in the query string; a longer list would not fit a URL.
const IDS_PER_QUERY = 100;

/** Display names by (normalised) account id. Throws when they cannot be read. */
async function namesOf(admin: Admin, ids: string[]) {
  const names = new Map<string, string>();
  for (let at = 0; at < ids.length; at += IDS_PER_QUERY) {
    const { data, error } = await admin
      .from('profiles')
      .select('id, name')
      .in('id', ids.slice(at, at + IDS_PER_QUERY));
    if (error) throw new LookupError('profiles', error);
    for (const p of data ?? []) names.set(normalId(p.id), p.name);
  }
  return names;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  const { admin, callerId, founding } = auth;

  try {
    // The founding organization's subscription, read before anything is
    // written. An answer this does not know is no access.
    const { data: access, error: accessErr } = await admin.rpc('org_access', { org: founding });
    if (accessErr) throw new LookupError('subscription of the founding organization', accessErr);
    if (access !== 'full' && access !== 'read_only') {
      return json({ error: "The organization's subscription is suspended or canceled" }, 402);
    }
    if (access === 'read_only' && req.method !== 'GET' && req.method !== 'DELETE') {
      return json({ error: "The organization's subscription has expired: until it is renewed, members can only be listed and deactivated" }, 402);
    }

    // --- list the crew ----------------------------------------------------
    if (req.method === 'GET') {
      // The crew is the founding organization's members, whatever their
      // status; role and badge are the membership's.
      const { data: members, error: memErr } = await admin
        .from('memberships')
        .select('user_id, role, badge_number')
        .eq('org_id', founding);
      if (memErr) throw new LookupError('memberships of the founding organization', memErr);
      const memberById = new Map((members ?? []).map((m) => [normalId(m.user_id), m]));

      const names = await namesOf(admin, [...memberById.keys()]);
      const accounts = await listAccounts(admin, (id) => memberById.has(id));

      const users = await Promise.all(
        accounts.map(async (u) => {
          const m = memberById.get(normalId(u.id))!;
          return {
            id: u.id,
            email: u.email,
            name: names.get(normalId(u.id)) ?? u.email?.split('@')[0] ?? '',
            role: m.role,
            badgeNumber: m.badge_number ?? '',
            createdAt: u.created_at,
            lastSignInAt: u.last_sign_in_at,
            deactivated: Boolean(u.banned_until && new Date(u.banned_until) > new Date()),
            // What they logged for this organization, and nothing of any other.
            records: await recordCounts(admin, u.id, founding),
            isSelf: normalId(u.id) === callerId,
          };
        })
      );
      users.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
      return json({ users });
    }

    // --- add someone ------------------------------------------------------
    if (req.method === 'POST') {
      const body = await req.json();
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const name = String(body.name ?? '').trim();
      const role = String(body.role ?? 'Driller');
      const badgeNumber = String(body.badgeNumber ?? '').trim();

      if (!email || !password) return json({ error: 'Email and password are required' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
      if (!ROLES.includes(role)) return json({ error: `Role must be one of ${ROLES.join(', ')}` }, 400);

      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // provisioned accounts do not need to confirm
        user_metadata: { name, badge_number: badgeNumber },
      });
      if (error) return json({ error: error.message }, 400);

      // The signup trigger creates the profile as a Driller. The role is set
      // here, server-side, and never from anything the account itself supplies.
      const { error: profErr } = await admin
        .from('profiles')
        .update({ name: name || email.split('@')[0], role, badge_number: badgeNumber || null })
        .eq('id', created.user!.id);
      if (profErr) return json({ error: profErr.message }, 500);

      return json({ id: created.user!.id, email, name, role }, 201);
    }

    // --- remove or deactivate --------------------------------------------
    if (req.method === 'DELETE') {
      const { id: sent } = await req.json();
      if (!sent) return json({ error: 'id is required' }, 400);
      if (isCaller(sent, callerId)) return json({ error: 'You cannot remove your own account' }, 400);
      const refused = await refuseTarget(admin, founding, sent);
      if (refused) return refused;
      const id = normalId(sent);

      // Everywhere, not only here: the account's rows in any organization
      // would lose their author.
      const records = await recordCounts(admin, id);

      if (records > 0) {
        // Their drilling records reference this account. Deleting it would
        // erase who did the work, so the account is disabled instead and the
        // profile stays so reports still resolve the name.
        const { error } = await admin.auth.admin.updateUserById(id, {
          ban_duration: '876000h', // ~100 years
        });
        if (error) return json({ error: error.message }, 500);
        return json({ action: 'deactivated', records });
      }

      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) return json({ error: error.message }, 500);
      return json({ action: 'deleted', records: 0 });
    }

    if (req.method === 'PATCH') {
      const { id: sent, action, role } = await req.json();
      if (!sent) return json({ error: 'id is required' }, 400);

      // --- change someone's role -------------------------------------------
      if (action === 'setRole') {
        if (!ROLES.includes(String(role))) {
          return json({ error: `Role must be one of ${ROLES.join(', ')}` }, 400);
        }
        // Demoting yourself could leave the project with no administrator,
        // and nobody left who could undo it from the dashboard.
        if (isCaller(sent, callerId)) return json({ error: 'You cannot change your own role' }, 400);
        const refused = await refuseTarget(admin, founding, sent);
        if (refused) return refused;
        const id = normalId(sent);

        const { data, error } = await admin
          .from('profiles')
          .update({ role })
          .eq('id', id)
          .select('id');
        if (error) return json({ error: error.message }, 500);
        if (!data?.length) return json({ error: 'No such account' }, 404);
        return json({ action: 'roleChanged', role });
      }

      // --- bring a deactivated account back ---------------------------------
      if (action !== 'reactivate') return json({ error: 'Unknown action' }, 400);
      const refused = await refuseTarget(admin, founding, sent);
      if (refused) return refused;
      const id = normalId(sent);

      // Deactivation must be reversible: doing it by mistake should not cost
      // someone their account, and the alternative is recreating them, which
      // would orphan every record their old id authored.
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: 'none' });
      if (error) return json({ error: error.message }, 500);
      return json({ action: 'reactivated' });
    }

    return json({ error: 'Unsupported method' }, 405);
  } catch (err) {
    return lookupFailed(err);
  }
});
