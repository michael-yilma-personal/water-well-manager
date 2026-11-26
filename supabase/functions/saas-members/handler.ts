/**
 * Member management for the administrators of one organization: every
 * decision of the `saas-members` function. Pure (no URL import, no Deno
 * global) so the unit tests import it; ./index.ts supplies the ports.
 *
 * Reusable: it knows organizations, memberships and accounts, and nothing of
 * the application built on them. An existing account is never banned, deleted
 * or given a new password here: only memberships change, and only through the
 * member functions of the database, which write the audit rows.
 */

export type Membership = {
  orgId: string; userId: string; role: string; status: string;
  badgeNumber: string | null; createdAt: string;
};
export type Account = { id: string; email: string; name: string; lastSignInAt: string | null };

/** Everything the handler needs from outside. A port throws when it cannot answer. */
export type Ports = {
  /** The account the request's Authorization header belongs to, or null. */
  callerId(authorization: string | null): Promise<string | null>;
  adminRoles(): Promise<string[]>;
  roles(): Promise<string[]>;
  membershipsOf(userId: string): Promise<Membership[]>;
  membersOf(orgId: string): Promise<Membership[]>;
  recordCount(orgId: string, userId: string): Promise<number>;
  accounts(ids: string[]): Promise<Account[]>;
  accountIdByEmail(email: string): Promise<string | null>;
  createAccount(input: { email: string; password: string; name: string; orgId: string }): Promise<string>;
  deleteAccount(id: string): Promise<void>;
  /** A member function of the database: its result, or the SQLSTATE of its refusal. */
  call(fn: string, args: Record<string, unknown>): Promise<{ data?: unknown; code?: string }>;
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = 'Something went wrong on the server. Please try again.';
const NO_MEMBER = 'No such member';

// The refusals of the member functions, by SQLSTATE. Anything else is a 500.
const REFUSALS: Record<string, [number, string]> = {
  SM002: [400, 'Unknown role'],
  SM008: [400, 'Unknown status'],
  SM005: [400, 'You cannot do this to your own membership'],
  SM003: [409, 'Already a member of this organization'],
  SM006: [409, 'The organization would be left without an active administrator'],
  SM007: [409, 'This membership is an invitation: it can be accepted or removed, nothing else'],
  SM004: [404, NO_MEMBER],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** 500 with the fixed message: the cause names tables and rows, so it is logged, never sent. */
function failed(cause: unknown) {
  console.error('saas-members:', cause instanceof Error ? cause.message : String(cause));
  return json({ error: FAILED }, 500);
}

function refusal(code: string | undefined) {
  const known = REFUSALS[code ?? ''];
  return known ? json({ error: known[1] }, known[0]) : failed(`member function refused with ${code}`);
}

// PostgreSQL takes a uuid in any case for the same id, so ids are compared lower-cased.
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function handle(req: Request, ports: Ports): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const sent = await ports.callerId(req.headers.get('Authorization'));
    if (!sent) return json({ error: 'Not signed in' }, 401);
    const caller = sent.toLowerCase();
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
      return json({ error: 'Unsupported method' }, 405);
    }

    const parsed = req.method === 'GET' ? null : await req.json().catch(() => null);
    const body: Record<string, unknown> = parsed && typeof parsed === 'object' ? parsed : {};
    const named = req.method === 'GET' ? new URL(req.url).searchParams.get('org_id') : body.org_id;
    if (typeof named !== 'string' || !UUID.test(named)) {
      return json({ error: 'org_id is required and must be an organization id' }, 400);
    }
    const org = named.toLowerCase();

    // An organization that does not exist has no members, so it gets the same answer.
    const adminRoles = await ports.adminRoles();
    const mayAdminister = (await ports.membershipsOf(caller)).some(
      (m) => sameId(m.orgId, org) && m.status === 'active' && adminRoles.includes(m.role));
    if (!mayAdminister) return json({ error: 'Organization administrators only' }, 403);

    if (req.method === 'GET') {
      const rows = await ports.membersOf(org);
      const accounts = await ports.accounts(rows.map((m) => m.userId));
      const members = [];
      for (const m of rows) {
        const account = accounts.find((a) => sameId(a.id, m.userId));
        // An invitation shows nothing of the invited person's account but the email it was sent to.
        const known = m.status !== 'invited';
        members.push({
          id: m.userId,
          email: account?.email ?? '',
          name: known ? account?.name ?? '' : '',
          role: m.role,
          badgeNumber: m.badgeNumber,
          status: m.status,
          createdAt: m.createdAt,
          lastSignInAt: known ? account?.lastSignInAt ?? null : null,
          records: await ports.recordCount(org, m.userId),
          isSelf: sameId(m.userId, caller),
        });
      }
      return json({ members });
    }

    const role = String(body.role ?? '');
    const badge = String(body.badgeNumber ?? '').trim() || null;

    if (req.method === 'POST') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return json({ error: 'A valid email is required' }, 400);
      if (!(await ports.roles()).includes(role)) return json({ error: 'Unknown role' }, 400);

      // An existing account is only invited: nothing of the account is touched
      // and the password sent is ignored. Being a member already is SM003.
      const existing = await ports.accountIdByEmail(email);
      if (existing) {
        const added = await ports.call('saas_add_member',
          { org, member: existing.toLowerCase(), role, badge, status: 'invited', actor: caller });
        return 'code' in added ? refusal(added.code) : json({ id: existing, outcome: 'invited' }, 201);
      }

      if (!password) return json({ error: 'Password is required for a new account' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
      let id: string;
      try {
        id = await ports.createAccount({ email, password, name: String(body.name ?? '').trim(), orgId: org });
      } catch (err) {
        // The address is held by an account that cannot be invited. Nothing was created.
        if ((err as { code?: unknown } | null)?.code !== 'email_exists') throw err;
        return json({ error: 'This address could not be added. Try again; if it repeats, this person cannot be added with this address.' }, 409);
      }
      // An account without its membership must not be left behind.
      let added: { data?: unknown; code?: string } = { code: '' };
      try {
        added = await ports.call('saas_add_member', { org, member: id, role, badge, status: 'active', actor: caller });
      } catch (err) {
        console.error('saas-members:', err instanceof Error ? err.message : String(err));
      }
      if ('code' in added) {
        try {
          await ports.deleteAccount(id);
        } catch (err) {
          return failed(`ORPHANED ACCOUNT ${id}: created without a membership and not deleted: ${err}`);
        }
        return refusal(added.code);
      }
      return json({ id, outcome: 'created' }, 201);
    }

    // PATCH and DELETE act on one member of this organization.
    const action = req.method === 'DELETE' ? 'remove' : body.action;
    if (!['remove', 'setRole', 'setBadge', 'deactivate', 'reactivate'].includes(action as string)) {
      return json({ error: 'Unknown action' }, 400);
    }
    if (typeof body.id !== 'string' || !body.id) return json({ error: 'id is required' }, 400);
    const member = body.id.toLowerCase();
    if (member === caller && action !== 'setBadge') return json({ error: 'You cannot do this to your own membership' }, 400);
    if (action === 'setRole' && !(await ports.roles()).includes(role)) {
      return json({ error: 'Unknown role' }, 400);
    }
    // Not an id, no account, a member elsewhere only: one answer, before any write.
    const isMember = UUID.test(member)
      && (await ports.membershipsOf(member)).some((m) => sameId(m.orgId, org));
    if (!isMember) return json({ error: NO_MEMBER }, 404);

    const who = { org, member, actor: caller };
    if (action === 'remove') {
      const records = await ports.recordCount(org, member);
      const removed = await ports.call('saas_remove_member', who);
      return 'code' in removed ? refusal(removed.code) : json({ action: removed.data, records });
    }
    const done = action === 'setRole' ? await ports.call('saas_set_member_role', { ...who, role })
      : action === 'setBadge' ? await ports.call('saas_set_member_badge', { ...who, badge })
      : await ports.call('saas_set_member_status',
        { ...who, status: action === 'deactivate' ? 'deactivated' : 'active' });
    return 'code' in done ? refusal(done.code) : json({ action });
  } catch (err) {
    return failed(err);
  }
}
