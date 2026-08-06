/**
 * Crew management for administrators.
 *
 * Creating and removing accounts needs the service-role key, which must never
 * reach a browser - anyone opening DevTools would have unrestricted access to
 * the whole database. So the key stays here, on the server, and this function
 * is the only thing that uses it.
 *
 * Every request is checked twice: the caller must present a valid session, and
 * that session's profile must have the Administrator role. The service-role
 * client bypasses Row Level Security by design, so the check is the only thing
 * standing between a driller's token and everyone else's accounts.
 *
 * Deletion is deliberately not always a delete. A driller who has logged pipe
 * records is deactivated rather than removed: their rows carry created_by, and
 * erasing the account would destroy the record of who drilled. Only an account
 * that has never logged anything is deleted outright.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

const ROLES = ['Driller', 'Supervisor', 'Administrator'];

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

/** Resolve the caller and confirm they are an administrator. */
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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();

  if (profile?.role !== 'Administrator') {
    return { error: json({ error: 'Administrators only' }, 403) };
  }
  return { admin, callerId: userData.user.id };
}

/** How many drilling rows an account authored, across every table. */
async function recordCounts(admin: ReturnType<typeof createClient>, userId: string) {
  const tables = ['boreholes', 'pipe_records', 'drilling_events', 'shift_logs'];
  let total = 0;
  for (const t of tables) {
    const { count } = await admin
      .from(t)
      .select('id', { count: 'exact', head: true })
      .eq('created_by', userId);
    total += count ?? 0;
  }
  return total;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;
  const { admin, callerId } = auth;

  try {
    // --- list the crew ----------------------------------------------------
    if (req.method === 'GET') {
      const { data: list, error } = await admin.auth.admin.listUsers({ perPage: 200 });
      if (error) return json({ error: error.message }, 500);

      const { data: profiles } = await admin
        .from('profiles')
        .select('id, name, role, badge_number');
      const byId = new Map((profiles ?? []).map((p) => [p.id, p]));

      const users = await Promise.all(
        list.users.map(async (u) => {
          const p = byId.get(u.id);
          return {
            id: u.id,
            email: u.email,
            name: p?.name ?? u.email?.split('@')[0] ?? '',
            role: p?.role ?? 'Driller',
            badgeNumber: p?.badge_number ?? '',
            createdAt: u.created_at,
            lastSignInAt: u.last_sign_in_at,
            deactivated: Boolean(u.banned_until && new Date(u.banned_until) > new Date()),
            records: await recordCounts(admin, u.id),
            isSelf: u.id === callerId,
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
      const { id } = await req.json();
      if (!id) return json({ error: 'id is required' }, 400);
      if (id === callerId) return json({ error: 'You cannot remove your own account' }, 400);

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

    // --- bring a deactivated account back ---------------------------------
    if (req.method === 'PATCH') {
      const { id, action } = await req.json();
      if (!id) return json({ error: 'id is required' }, 400);
      if (action !== 'reactivate') return json({ error: 'Unknown action' }, 400);

      // Deactivation must be reversible: doing it by mistake should not cost
      // someone their account, and the alternative is recreating them, which
      // would orphan every record their old id authored.
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: 'none' });
      if (error) return json({ error: error.message }, 500);
      return json({ action: 'reactivated' });
    }

    return json({ error: 'Unsupported method' }, 405);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
