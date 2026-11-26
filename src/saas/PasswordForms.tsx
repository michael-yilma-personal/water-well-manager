/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { changePassword, requestReset, setRecoveredPassword } from './password';

/**
 * The password forms every app shows (P5-1, P5-2). Plain blocks rather than
 * <form>s, so they can sit inside another form; Enter submits them.
 */

const input = 'p-3 rounded border-2 border-white/20 bg-black text-white font-bold';
const button = 'py-2.5 rounded-lg bg-[#FFD700] text-black font-black uppercase tracking-wider text-xs disabled:opacity-50';
const errorText = 'text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-2';
const okText = 'text-xs font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded p-2';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Fields = Record<string, { label: string; autoComplete: string; type?: string }>;

function Block({ fields, values, onChange, submit, busy, error, done, action, note }: {
  fields: Fields; values: Record<string, string>; onChange: (v: Record<string, string>) => void;
  submit: () => void; busy: boolean; error: string | null; done: string | null; action: string; note?: string;
}) {
  return (
    <div className="flex flex-col gap-2" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}>
      {Object.entries(fields).map(([key, f]) => (
        <input key={key} type={f.type ?? 'password'} aria-label={f.label} placeholder={f.label} autoComplete={f.autoComplete}
               value={values[key] ?? ''} onChange={(e) => onChange({ ...values, [key]: e.target.value })} className={input} />
      ))}
      {note && <p className="text-[11px] font-semibold text-slate-400">{note}</p>}
      {error && <p className={errorText}>{error}</p>}
      {done && <p className={okText}>{done}</p>}
      <button type="button" disabled={busy} onClick={submit} className={button}>{busy ? 'Please wait…' : action}</button>
    </div>
  );
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (work: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try { setDone(await work()); } catch (e) { setError(message(e)); }
    setBusy(false);
  };
  return { busy, error, done, run };
}

/** The signed-in person changes their password; they stay signed in. */
export function ChangePassword({ client }: { client: SupabaseClient | null }) {
  const [v, setV] = useState<Record<string, string>>({});
  const { run, ...state } = useRun();
  const submit = () => run(async () => {
    const email = client && (await client.auth.getSession()).data.session?.user.email;
    if (!client || !email) throw new Error('Sign in first to change the password.');
    await changePassword(client, email, v.current ?? '', v.next ?? '', v.repeat ?? '');
    setV({});
    return 'Your password has been changed.';
  });
  return (
    <Block {...state} values={v} onChange={setV} submit={submit} action="Change password"
           note="Other devices signed in to this account will ask to sign in again." fields={{
      current: { label: 'Current password', autoComplete: 'current-password' },
      next: { label: 'New password', autoComplete: 'new-password' },
      repeat: { label: 'New password again', autoComplete: 'new-password' },
    }} />
  );
}

/** "Forgot password?": the reset email, answered with the same sentence whatever the server said. */
export function ForgotPassword({ client, redirectTo }: { client: SupabaseClient | null; redirectTo: string }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  const { run, ...state } = useRun();
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="self-start text-xs font-bold text-slate-400 underline">Forgot password?</button>;
  }
  const submit = () => run(async () => {
    if (!(v.email ?? '').trim()) throw new Error('Enter your email address.');
    if (!client) throw new Error('No backend is configured for this build.');
    return requestReset(client, v.email, redirectTo);
  });
  return (
    <Block {...state} values={v} onChange={setV} submit={submit} action="Send reset link"
           fields={{ email: { label: 'Email', autoComplete: 'username', type: 'email' } }} />
  );
}

/** A password-recovery session sets the new password, then is signed out on this browser. */
export function RecoverPassword({ client }: { client: SupabaseClient }) {
  const [v, setV] = useState<Record<string, string>>({});
  const { run, ...state } = useRun();
  const submit = () => run(async () => {
    await setRecoveredPassword(client, v.next ?? '', v.repeat ?? '');
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    return 'Your password is set. Sign in again in the app you use.';
  });
  if (state.done) return <p className={okText}>{state.done}</p>;
  return (
    <Block {...state} values={v} onChange={setV} submit={submit} action="Set password" fields={{
      next: { label: 'New password', autoComplete: 'new-password' },
      repeat: { label: 'New password again', autoComplete: 'new-password' },
    }} />
  );
}
