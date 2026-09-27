/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, RotateCcw, UserPlus, UserX } from 'lucide-react';
import {
  addCrewMember,
  fetchCrew,
  reactivateCrewMember,
  removeCrewMember,
  type CrewMember,
} from './crewApi';

/**
 * Add and remove crew accounts.
 *
 * Removing someone who has logged work deactivates them instead of deleting:
 * their pipe records name them, and erasing the account would destroy the
 * record of who drilled. The table shows the record count so the outcome is
 * predictable before the button is pressed.
 */

const ROLE_HELP: Record<string, string> = {
  Driller: 'Logs pipes on a rig. Sees only their own boreholes.',
  'Data Logger':
    'Records pipes, formations and events for the rig. Same access as Driller; logged under their own name.',
  Supervisor:
    'Currently identical to Driller — crew-wide visibility is not built yet.',
  Administrator:
    'Reads every crew\'s records and manages accounts. Cannot log field data.',
};

function AddForm({ onAdded }: { onAdded: () => void }) {
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
      await addCrewMember({ email: email.trim(), password, name: name.trim(), role, badgeNumber: badge.trim() });
      setEmail(''); setPassword(''); setName(''); setBadge(''); setRole('Driller');
      setOpen(false);
      onAdded();
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
            <option>Driller</option>
            <option>Data Logger</option>
            <option>Supervisor</option>
            <option>Administrator</option>
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
        there is signal, and the device stays linked afterwards.
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

export function CrewView({ onBack }: { onBack: () => void }) {
  const [crew, setCrew] = useState<CrewMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setBusy(true);
    fetchCrew()
      .then((c) => { setCrew(c); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(load, [load]);

  const remove = async (m: CrewMember) => {
    const willDeactivate = m.records > 0;
    const message = willDeactivate
      ? `${m.name} has logged ${m.records} record(s).\n\nTheir account will be disabled so they can no longer sign in, but their records and their name stay in the drilling log. Continue?`
      : `${m.name} has logged nothing yet, so their account will be deleted outright. Continue?`;
    if (!window.confirm(message)) return;
    try {
      const r = await removeCrewMember(m.id);
      setNotice(r.action === 'deactivated'
        ? `${m.name} can no longer sign in. Their ${r.records} record(s) are untouched.`
        : `${m.name} was removed.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reactivate = async (m: CrewMember) => {
    try {
      await reactivateCrewMember(m.id);
      setNotice(`${m.name} can sign in again.`);
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

        <AddForm onAdded={() => { setNotice('Account created.'); load(); }} />

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
                <tr key={m.id} className={m.deactivated ? 'opacity-50' : 'hover:bg-slate-900/60'}>
                  <td className="p-3 font-black whitespace-nowrap">
                    {m.name}{m.isSelf && <span className="ml-2 text-[10px] text-slate-500">(you)</span>}
                  </td>
                  <td className="p-3">{m.email}</td>
                  <td className="p-3 whitespace-nowrap">{m.role}</td>
                  <td className="p-3 whitespace-nowrap">{m.badgeNumber || '—'}</td>
                  <td className="p-3">{m.records}</td>
                  <td className="p-3 whitespace-nowrap text-xs text-slate-400">
                    {m.lastSignInAt ? new Date(m.lastSignInAt).toLocaleString() : 'never'}
                  </td>
                  <td className="p-3 whitespace-nowrap text-xs font-black">
                    {m.deactivated
                      ? <span className="text-amber-400">Disabled</span>
                      : <span className="text-emerald-400">Active</span>}
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    {m.isSelf ? (
                      <span className="text-slate-600 text-xs">—</span>
                    ) : m.deactivated ? (
                      <button onClick={() => reactivate(m)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-emerald-500/40 text-emerald-300 text-xs font-black uppercase">
                        <RotateCcw className="w-3.5 h-3.5" /> Restore
                      </button>
                    ) : (
                      <button onClick={() => remove(m)}
                              title={m.records > 0 ? 'Disables sign-in; records are kept' : 'Deletes the account'}
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
          records name them, and removing the account would erase the record of
          who drilled. Disabling is reversible.
        </p>
      </div>
    </div>
  );
}
