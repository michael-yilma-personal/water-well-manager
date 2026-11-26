/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, RotateCcw, UserPlus, UserX } from 'lucide-react';
import { saas } from './saas';
import type { Member } from '../saas/api';

/**
 * Add and remove the members of the active organization.
 *
 * Removing someone who has logged work deactivates their membership instead of
 * removing it: their pipe records name them. The table shows the record count
 * so the outcome is predictable before the button is pressed. None of this
 * touches the person's account: they may belong to other organizations.
 */

const ROLES = ['Driller', 'Data Logger', 'Supervisor', 'Administrator'];

/** An invited person has no name here until they accept. */
const label = (m: Member) => m.name || m.email;

const ROLE_HELP: Record<string, string> = {
  Driller: 'Logs pipes on a rig. Sees only their own boreholes.',
  'Data Logger':
    'Records pipes, formations and events for the rig. Same access as Driller; logged under their own name.',
  Supervisor:
    'Currently identical to Driller — crew-wide visibility is not built yet.',
  Administrator:
    'Reads every crew\'s records and manages accounts. Cannot log field data.',
};

function AddForm({ orgId, onAdded }: { orgId: string; onAdded: (notice: string) => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [badge, setBadge] = useState('');
  const [role, setRole] = useState('Driller');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const added = email.trim();
      const { outcome } = await saas.addMember(orgId, {
        email: added, password, name: name.trim(), role, badgeNumber: badge.trim(),
      });
      setEmail(''); setPassword(''); setName(''); setBadge(''); setRole('Driller');
      setOpen(false);
      onAdded(outcome === 'invited'
        ? `${added} already has an account, so they were invited. They must sign in and accept before they can see anything here. Their password was not changed.`
        : 'Account created.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#FFD700] text-black font-black uppercase tracking-wider text-xs"
      >
        <UserPlus className="w-4 h-4" /> Add crew member
      </button>
    );
  }

  const field = 'w-full p-2.5 rounded bg-slate-800 border border-slate-600 text-sm font-semibold';

  return (
    <form onSubmit={submit} className="w-full rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <label className="text-[11px] uppercase tracking-wider font-black text-slate-400">
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                 autoComplete="off" className={`mt-1 ${field}`} />
        </label>
        <label className="text-[11px] uppercase tracking-wider font-black text-slate-400">
          Temporary password
          <input type="text" required minLength={8} value={password}
                 onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
                 placeholder="at least 8 characters" className={`mt-1 ${field}`} />
        </label>
        <label className="text-[11px] uppercase tracking-wider font-black text-slate-400">
          Full name
          <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
                 placeholder="Joe Kamau" className={`mt-1 ${field}`} />
        </label>
        <label className="text-[11px] uppercase tracking-wider font-black text-slate-400">
          Badge number
          <input type="text" value={badge} onChange={(e) => setBadge(e.target.value)}
                 placeholder="DRL-110" className={`mt-1 ${field}`} />
        </label>
        <label className="text-[11px] uppercase tracking-wider font-black text-slate-400">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)} className={`mt-1 ${field}`}>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <div className="flex items-end">
          <p className="text-[11px] text-slate-400 font-semibold leading-snug">{ROLE_HELP[role]}</p>
        </div>
      </div>

      {error && (
        <p className="mt-3 text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-2">
          {error}
        </p>
      )}

      <p className="mt-3 text-[11px] text-slate-500 font-semibold">
        Give them this password directly. They sign in once on their phone where
        there is signal, and the device stays linked afterwards. If the email
        already has an account, the person is invited instead and keeps their
        own password.
      </p>

      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy}
                className="px-4 py-2.5 rounded-lg bg-[#FFD700] text-black font-black uppercase tracking-wider text-xs disabled:opacity-50">
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }}
                className="px-4 py-2.5 rounded-lg border border-slate-600 text-slate-300 font-black uppercase tracking-wider text-xs">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CrewView({ orgId, onBack }: { orgId: string; onBack: () => void }) {
  const [crew, setCrew] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    saas.listMembers(orgId)
      .then((c) => { setCrew(c); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [orgId]);

  useEffect(load, [load]);

  const remove = async (m: Member) => {
    const willDeactivate = m.records > 0;
    const message = willDeactivate
      ? `${label(m)} has logged ${m.records} record(s).\n\nTheir membership will be deactivated, so they lose access to this organization, but their records and their name stay in the drilling log. Continue?`
      : `${label(m)} has logged nothing here, so they will be removed from this organization. Continue?`;
    if (!window.confirm(message)) return;
    try {
      const r = await saas.removeMember(orgId, m.id);
      setNotice(r.action === 'deactivated'
        ? `${label(m)} was deactivated in this organization because they have ${r.records} record(s) here. The records are untouched.`
        : `${label(m)} was removed from this organization.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const changeRole = async (m: Member, role: string) => {
    if (role === m.role) return;
    // Administrator is the one role that changes access, in both directions,
    // so say what is about to happen before it does.
    const warning =
      role === 'Administrator'
        ? `\n\nAs an Administrator they will read every crew's records and will no longer be able to log field data.`
        : m.role === 'Administrator'
          ? `\n\nThey will lose access to other crews' records and to this dashboard.`
          : `\n\nTheir access does not change, and their existing records are untouched.`;
    if (!window.confirm(`Change ${label(m)} from ${m.role} to ${role}?${warning}`)) return;
    try {
      await saas.setMemberRole(orgId, m.id, role);
      // The crew list takes seconds to reload (it counts every account's
      // records); until then the select would snap back to the old role.
      setCrew((c) => c?.map((x) => (x.id === m.id ? { ...x, role } : x)) ?? c);
      setNotice(`${label(m)} is now ${role === 'Administrator' ? 'an' : 'a'} ${role}. It takes effect the next time they open the app.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reactivate = async (m: Member) => {
    try {
      await saas.reactivateMember(orgId, m.id);
      setNotice(`${label(m)} is active in this organization again.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-4 flex items-center gap-4 flex-wrap">
        <button onClick={onBack} className="flex items-center gap-1.5 text-slate-300 font-bold text-sm">
          <ArrowLeft className="w-4 h-4" /> Boreholes
        </button>
        <h1 className="text-lg font-black">Crew</h1>
        <span className="text-xs text-slate-400 font-semibold">
          Accounts that can sign in and log work
        </span>
        <button onClick={load} disabled={busy} title="Reload"
                className="ml-auto p-2 rounded bg-slate-800 border border-slate-700 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </header>

      <div className="p-6 flex flex-col gap-4">
        {error && (
          <div className="p-3 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-sm font-bold">
            {error}
          </div>
        )}
        {notice && (
          <div className="p-3 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-sm font-bold flex justify-between gap-3">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="uppercase text-xs underline">Dismiss</button>
          </div>
        )}

        <AddForm orgId={orgId} onAdded={(text) => { setNotice(text); load(); }} />

        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase tracking-wider">
              <tr>
                {['Name', 'Email', 'Role', 'Badge', 'Records', 'Last sign-in', 'Status', ''].map((h) => (
                  <th key={h} className="text-left p-3 font-black whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {(crew ?? []).map((m) => (
                <tr key={m.id} className={m.status === 'deactivated' ? 'opacity-50' : 'hover:bg-slate-900/60'}>
                  <td className="p-3 font-black whitespace-nowrap">
                    {m.name || '—'}{m.isSelf && <span className="ml-2 text-[10px] text-slate-500">(you)</span>}
                  </td>
                  <td className="p-3">{m.email}</td>
                  <td className="p-3 whitespace-nowrap">
                    {m.isSelf || m.status === 'deactivated' ? (
                      m.role
                    ) : (
                      <select value={m.role} aria-label={`Role for ${label(m)}`}
                              onChange={(e) => changeRole(m, e.target.value)}
                              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm font-bold">
                        {ROLES.map((r) => <option key={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="p-3 whitespace-nowrap">{m.badgeNumber || '—'}</td>
                  <td className="p-3">{m.records}</td>
                  <td className="p-3 whitespace-nowrap text-xs text-slate-400">
                    {m.lastSignInAt ? new Date(m.lastSignInAt).toLocaleString() : 'never'}
                  </td>
                  <td className="p-3 whitespace-nowrap text-xs font-black">
                    {m.status === 'deactivated'
                      ? <span className="text-amber-400">Disabled</span>
                      : m.status === 'invited'
                        ? <span className="text-blue-300">Invited</span>
                        : <span className="text-emerald-400">Active</span>}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    {m.isSelf ? (
                      <span className="text-slate-600 text-xs">—</span>
                    ) : m.status === 'deactivated' ? (
                      <button onClick={() => reactivate(m)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-emerald-500/40 text-emerald-300 text-xs font-black uppercase">
                        <RotateCcw className="w-3.5 h-3.5" /> Restore
                      </button>
                    ) : (
                      <button onClick={() => remove(m)}
                              title={m.records > 0 ? 'Deactivates the membership; records are kept' : 'Removes them from this organization'}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-rose-500/40 text-rose-300 text-xs font-black uppercase">
                        <UserX className="w-3.5 h-3.5" /> {m.records > 0 ? 'Disable' : 'Delete'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!crew && !error && (
                <tr><td colSpan={8} className="p-8 text-center text-slate-500">Loading…</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-slate-500 font-semibold max-w-3xl">
          Someone who has logged work is disabled rather than deleted: their pipe
          records name them. Disabling is reversible. Neither changes the
          person&apos;s account or password, or their place in any other organization.
        </p>
      </div>
    </div>
  );
}
