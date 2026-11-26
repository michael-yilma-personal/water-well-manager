import React, { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditEntry, Organization, Plan, PlatformApi, PlatformMember } from './api';

/**
 * The platform administrator's console: organizations, their first
 * administrator, subscriptions and the audit history. One page, no router.
 * The server decides everything; an account that is not a platform
 * administrator is shown no data.
 */

type User = { id: string; email?: string };
type Person = { email: string; name: string; password: string };
type Run = (work: () => Promise<unknown>, done: string) => Promise<void>;

const field = 'p-2 rounded border border-slate-700 bg-slate-900 text-sm font-bold';
const label = 'flex flex-col gap-1 text-[11px] uppercase tracking-wider font-black text-slate-400';
const primary = 'px-4 py-2.5 rounded-lg bg-[#FFD700] text-black font-black uppercase tracking-wider text-xs disabled:opacity-50';
const plain = 'px-3 py-2 rounded border border-slate-600 text-slate-300 font-black uppercase tracking-wider text-xs';
const card = 'rounded-lg border border-slate-700 bg-slate-900 p-4 flex flex-wrap items-end gap-3';
const heading = 'text-sm font-black uppercase tracking-wider text-slate-400';
const errorBox = 'p-3 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-sm font-bold';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
// End dates are whole days: entered as a date, sent as the end of that day (UTC), shown as the date.
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
const endOfDay = (date: string) => `${date}T23:59:59Z`;

const ACTIONS = [
  ['start_trial', 'Start trial'], ['activate', 'Activate'], ['extend', 'Extend'], ['change_plan', 'Change plan'],
  ['override', 'Override the user limit'], ['suspend', 'Suspend'], ['reactivate', 'Reactivate'], ['cancel', 'Cancel'],
];
const NO_PERSON: Person = { email: '', name: '', password: '' };

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][] | null; empty: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-800">
      <table className="w-full text-sm">
        <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase tracking-wider">
          <tr>{head.map((h) => <th key={h} className="text-left p-3 font-black whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {rows?.map((cells, i) => (
            <tr key={i}>{cells.map((c, j) => <td key={j} className="p-3 align-top">{c}</td>)}</tr>
          ))}
          {!rows?.length && (
            <tr><td colSpan={head.length} className="p-6 text-center text-slate-500">{rows ? empty : 'Loading…'}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function PersonFields({ value, onChange }: { value: Person; onChange: (p: Person) => void }) {
  const set = (key: keyof Person) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: e.target.value });
  return (
    <>
      <label className={label}>First administrator's email
        <input type="email" required autoComplete="off" value={value.email} onChange={set('email')} className={field} />
      </label>
      <label className={label}>Their name
        <input required value={value.name} onChange={set('name')} className={field} />
      </label>
      <label className={label}>Temporary password
        <input type="password" required minLength={8} autoComplete="new-password" placeholder="at least 8 characters"
               value={value.password} onChange={set('password')} className={field} />
      </label>
    </>
  );
}

function Audit({ api, orgId, names }: { api: PlatformApi; orgId?: string; names: Record<string, string> }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    api.listAudit(orgId).then((r) => { if (!stale) setRows(r); }, (e) => { if (!stale) setError(message(e)); });
    return () => { stale = true; };
  }, [api, orgId]);
  const name = (id: string | null) => (id ? names[id] ?? id : '—');
  return (
    <section className="flex flex-col gap-2">
      <h2 className={heading}>Audit history</h2>
      {error ? <div className={errorBox}>{error}</div> : (
        <Table
          head={['Time', 'Actor', ...(orgId ? [] : ['Organization']), 'Action', 'Details']}
          empty="Nothing recorded yet."
          rows={rows && rows.map((a) => [
            <span className="whitespace-nowrap text-xs">{new Date(a.at).toLocaleString()}</span>,
            <span className="text-xs">{name(a.actorId)}</span>,
            ...(orgId ? [] : [<span className="text-xs">{name(a.orgId)}</span>]),
            <span className="whitespace-nowrap font-black">{a.action}</span>,
            <span className="font-mono text-xs break-all text-slate-300">
              {a.target ? `${name(a.target)} ` : ''}{a.details == null ? '' : JSON.stringify(a.details)}
            </span>,
          ])}
        />
      )}
    </section>
  );
}

function CreateForm({ api, plans, onCreated }: {
  api: PlatformApi;
  plans: Plan[];
  onCreated: (orgId: string, notice: string | null, error: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [plan, setPlan] = useState('');
  const [status, setStatus] = useState('trial');
  const [ends, setEnds] = useState('');
  const [person, setPerson] = useState(NO_PERSON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const email = person.email.trim();
    try {
      const id = await api.createOrganization({
        name: name.trim(), plan: plan || plans[0]?.id, status, endsAt: ends ? endOfDay(ends) : null,
      });
      // The organization now exists: a failure from here on must not read as "nothing happened".
      try {
        const { outcome } = await api.addFirstAdmin(id, { ...person, email, name: person.name.trim() });
        onCreated(id, outcome === 'created'
          ? `${name.trim()} was created. ${email} is its administrator and signs in with the temporary password.`
          : `${name.trim()} was created. ${email} already has an account and was invited as its administrator; the password entered was not used.`, null);
      } catch (err) {
        onCreated(id, null, `${name.trim()} was created, but its administrator was not added: ${message(err)} — add the administrator below.`);
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={card}>
      <h2 className={`${heading} w-full`}>New organization</h2>
      <label className={label}>Name
        <input required value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <label className={label}>Plan
        <select required value={plan || plans[0]?.id || ''} onChange={(e) => setPlan(e.target.value)} className={field}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className={label}>Starts as
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={field}>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
        </select>
      </label>
      <label className={label}>End date (optional)
        <input type="date" value={ends} onChange={(e) => setEnds(e.target.value)} className={field} />
      </label>
      <PersonFields value={person} onChange={setPerson} />
      <button type="submit" disabled={busy} className={primary}>{busy ? 'Creating…' : 'Create'}</button>
      {error && <p className={`${errorBox} w-full`}>{error}</p>}
    </form>
  );
}

function OrgPage({ api, org, plans, me, version, busy, run }: {
  api: PlatformApi; org: Organization; plans: Plan[]; me: User; version: number; busy: boolean; run: Run;
}) {
  const [members, setMembers] = useState<PlatformMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState('extend');
  const [ends, setEnds] = useState('');
  const [noEnd, setNoEnd] = useState(false);
  // The form starts from what the organization has, so applying it unchanged changes nothing.
  const [plan, setPlan] = useState(org.plan ?? '');
  const [maxUsers, setMaxUsers] = useState(org.maxUsersOverride == null ? '' : String(org.maxUsersOverride));
  const [note, setNote] = useState(org.notes ?? '');
  const [person, setPerson] = useState(NO_PERSON);

  useEffect(() => {
    let stale = false;
    api.listMembers(org.id).then((m) => { if (!stale) setMembers(m); }, (e) => { if (!stale) setLoadError(message(e)); });
    return () => { stale = true; };
  }, [api, org.id, version]);

  const takesDate = ['start_trial', 'activate', 'reactivate', 'extend'].includes(action);
  // A current plan that is no longer offered cannot be chosen again.
  const chosenPlan = plans.find((p) => p.id === plan)?.id ?? plans[0]?.id ?? '';
  const actionLabel = ACTIONS.find(([id]) => id === action)?.[1] ?? action;

  const change = (e: React.FormEvent) => {
    e.preventDefault();
    const args: Record<string, unknown> = {};
    if (takesDate && ends) args.ends_at = endOfDay(ends);
    else if (takesDate && action !== 'extend' && noEnd) args.ends_at = null;
    if (action === 'change_plan') args.plan = chosenPlan;
    if (action === 'override') args.max_users = maxUsers === '' ? null : Number(maxUsers);
    if (note !== (org.notes ?? '')) args.notes = note;
    if (action === 'suspend' || action === 'cancel') {
      const what = action === 'suspend' ? 'Suspend' : 'Cancel the subscription of';
      if (!window.confirm(`${what} ${org.name}? Its members lose access until it is reactivated.`)) return;
    }
    void run(() => api.updateSubscription(org.id, action, args), `${actionLabel}: done.`);
    // Nothing about the end date carries over to the next action.
    setEnds('');
    setNoEnd(false);
  };

  const addPerson = (e: React.FormEvent) => {
    e.preventDefault();
    const email = person.email.trim();
    void run(async () => {
      await api.addFirstAdmin(org.id, { ...person, email, name: person.name.trim() });
      setPerson(NO_PERSON);
    }, `${email} was added as the administrator.`);
  };

  const names: Record<string, string> = { [org.id]: org.name };
  if (me.email) names[me.id] = me.email;
  for (const m of members ?? []) names[m.id] = m.email;
  const hasAdmin = members?.some((m) => m.role === api.adminRole && m.status === 'active');

  return (
    <>
      <section className="flex flex-col gap-2">
        <h2 className={heading}>Subscription</h2>
        <Table
          head={['Plan', 'Status', 'Started', 'End date', 'Grace days', 'Access', 'User limit override', 'Members', 'Note']}
          empty=""
          rows={[[
            org.plan ?? '—', org.status ?? 'No subscription', day(org.startsAt), day(org.endsAt), org.graceDays ?? '—',
            org.access, org.maxUsersOverride ?? '—', org.members, org.notes || '—',
          ]]}
        />
        <form onSubmit={change} className={card}>
          <label className={label}>Action
            <select value={action} onChange={(e) => { setAction(e.target.value); setEnds(''); setNoEnd(false); }} className={field}>
              {ACTIONS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
            </select>
          </label>
          {takesDate && (
            <label className={label}>{action === 'extend' ? 'New end date' : 'End date (blank: unchanged)'}
              <input type="date" required={action === 'extend'} value={ends} onChange={(e) => setEnds(e.target.value)} className={field} />
            </label>
          )}
          {takesDate && action !== 'extend' && !ends && (
            <label className="flex items-center gap-2 text-xs font-bold text-slate-300 pb-2">
              <input type="checkbox" checked={noEnd} onChange={(e) => setNoEnd(e.target.checked)} /> Remove the end date
            </label>
          )}
          {action === 'change_plan' && (
            <label className={label}>Plan
              <select value={chosenPlan} onChange={(e) => setPlan(e.target.value)} className={field}>
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          {action === 'override' && (
            <label className={label}>User limit (blank: the plan's)
              <input type="number" min={0} step={1} value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)} className={field} />
            </label>
          )}
          <label className={`${label} grow`}>Note (seen by platform administrators only)
            <input value={note} onChange={(e) => setNote(e.target.value)} className={field} />
          </label>
          <button type="submit" disabled={busy} className={primary}>Apply</button>
        </form>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={heading}>Members</h2>
        {loadError ? <div className={errorBox}>{loadError}</div> : (
          <Table
            head={['Name', 'Email', 'Role', 'Status']}
            empty="No members yet."
            rows={members && members.map((m) => [m.name || '—', m.email, m.role, m.status])}
          />
        )}
        {members && !hasAdmin && (
          <form onSubmit={addPerson} className={card}>
            <h3 className={`${heading} w-full`}>This organization has no active administrator</h3>
            <PersonFields value={person} onChange={setPerson} />
            <button type="submit" disabled={busy} className={primary}>Add administrator</button>
          </form>
        )}
      </section>

      <Audit key={version} api={api} orgId={org.id} names={names} />
    </>
  );
}

function Console({ api, me }: { api: PlatformApi; me: User }) {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [o, p] = await Promise.all([api.listOrganizations(), api.listPlans()]);
      setOrgs(o);
      setPlans(p.filter((x) => x.isActive));
    } catch (e) {
      setError(message(e));
    }
    setVersion((v) => v + 1);
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const run: Run = async (work, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (e) {
      setError(message(e));
    }
    await reload();
    setBusy(false);
  };

  const go = (id: string | null) => { setOpenId(id); setNotice(null); setError(null); };
  const open = orgs?.find((o) => o.id === openId);
  const names: Record<string, string> = Object.fromEntries((orgs ?? []).map((o) => [o.id, o.name]));
  if (me.email) names[me.id] = me.email;

  return (
    <div className="p-6 flex flex-col gap-6">
      {open && (
        <div className="flex items-center gap-4">
          <button onClick={() => go(null)} className={plain}>← All organizations</button>
          <h1 className="text-lg font-black">{open.name}</h1>
        </div>
      )}
      {error && <div className={errorBox}>{error}</div>}
      {notice && (
        <div className="p-3 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-sm font-bold">{notice}</div>
      )}
      {open ? (
        <OrgPage key={open.id} api={api} org={open} plans={plans} me={me} version={version} busy={busy} run={run} />
      ) : (
        <>
          <CreateForm
            api={api}
            plans={plans}
            onCreated={(id, n, e) => { setOpenId(id); setNotice(n); setError(e); void reload(); }}
          />
          <section className="flex flex-col gap-2">
            <h2 className={heading}>Organizations</h2>
            <Table
              head={['Name', 'Plan', 'Status', 'End date', 'Access', 'Members']}
              empty="No organizations yet."
              rows={orgs && orgs.map((o) => [
                <button onClick={() => go(o.id)} className="font-black underline text-left">{o.name}</button>,
                o.plan ?? '—', o.status ?? 'No subscription', day(o.endsAt), o.access, o.members,
              ])}
            />
          </section>
          <Audit key={version} api={api} names={names} />
        </>
      )}
    </div>
  );
}

function SignIn({ client, title, onIn }: { client: SupabaseClient | null; title: string; onIn: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(client ? null : 'No backend is configured for this build.');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client) return;
    setBusy(true);
    setError(null);
    const { data, error: failure } = await client.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (failure || !data.user) setError(failure?.message ?? 'Sign-in returned no user');
    else onIn(data.user);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-3">
        <h1 className="text-2xl font-black tracking-tight">{title}</h1>
        <p className="text-sm text-slate-400 font-semibold mb-3">Platform administrator sign-in.</p>
        <input type="email" required placeholder="Email" autoComplete="username" value={email}
               onChange={(e) => setEmail(e.target.value)} className="p-3 rounded border-2 border-white/20 bg-black font-bold" />
        <input type="password" required placeholder="Password" autoComplete="current-password" value={password}
               onChange={(e) => setPassword(e.target.value)} className="p-3 rounded border-2 border-white/20 bg-black font-bold" />
        {error && <p className="text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-2">{error}</p>}
        <button type="submit" disabled={busy} className={`mt-1 py-3 ${primary}`}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export default function PlatformApp({ api, client, title }: { api: PlatformApi; client: SupabaseClient | null; title: string }) {
  // undefined: not known yet.
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [admin, setAdmin] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Follows the session, also when it changes in another tab: the first event carries the stored one.
  useEffect(() => {
    if (!client) return setUser(null);
    const { data } = client.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, [client]);

  const userId = user?.id;
  useEffect(() => {
    setAdmin(undefined);
    setError(null);
    if (!userId) return;
    let stale = false;
    // Only a plain yes opens the console: an error is shown and counts as no.
    api.isPlatformAdmin().then(
      (yes) => { if (!stale) setAdmin(yes); },
      (e) => { if (!stale) { setAdmin(false); setError(message(e)); } },
    );
    return () => { stale = true; };
  }, [api, userId]);

  const signOut = async () => {
    // This browser's console session only.
    await client?.auth.signOut({ scope: 'local' }).catch(() => undefined);
    setUser(null);
  };

  if (user === null) return <SignIn client={client} title={title} onIn={setUser} />;
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-4 flex items-center gap-4 flex-wrap">
        <h1 className="text-lg font-black">{title}</h1>
        <span className="text-xs text-slate-400 font-semibold">Platform console</span>
        {user && (
          <>
            <span className="text-xs text-slate-400 font-semibold ml-auto">{user.email}</span>
            <button onClick={signOut} className={plain}>Sign out</button>
          </>
        )}
      </header>
      {user && admin === true ? <Console key={user.id} api={api} me={user} /> : (
        <div className="p-6 flex flex-col gap-3">
          {admin === undefined && <p className="text-slate-500">Checking…</p>}
          {admin === false && !error && <p className="font-bold">This account is not a platform administrator.</p>}
          {error && <div className={errorBox}>Could not check whether this account is a platform administrator: {error}</div>}
        </div>
      )}
    </div>
  );
}
