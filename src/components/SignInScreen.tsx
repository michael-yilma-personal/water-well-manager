/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { LogIn, WifiOff } from 'lucide-react';
import { signIn } from '../services/auth';
import { isSupabaseConfigured } from '../services/supabaseClient';

/**
 * One-time device provisioning.
 *
 * Shown only until a session exists on the device. After that the driller is
 * never asked again, because a rig with no signal cannot complete a sign-in and
 * a login wall there would stop work entirely.
 */
export function SignInScreen({
  onSignedIn,
  onSkip,
}: {
  onSignedIn: () => void;
  onSkip: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = isSupabaseConfigured();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white flex flex-col items-center justify-center p-5">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-black tracking-tight">PERIPLUS DRILL</h1>
        <p className="text-sm text-slate-400 font-semibold mb-6">
          Sign in once to link this device to your rig. You will not be asked
          again, and the app keeps working with no signal.
        </p>

        {!configured && (
          <div className="mb-4 p-3 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs font-bold">
            This build has no Supabase project configured. Data will stay on
            this device only.
          </div>
        )}

        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="text-[11px] font-black uppercase tracking-wider text-slate-400">
            Email
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full p-3 rounded border-2 border-white/20 bg-black text-white font-bold text-base"
            />
          </label>

          <label className="text-[11px] font-black uppercase tracking-wider text-slate-400">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full p-3 rounded border-2 border-white/20 bg-black text-white font-bold text-base"
            />
          </label>

          {error && (
            <p className="text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !configured}
            className="mt-2 w-full py-3.5 rounded-xl bg-[#FFD700] text-black font-black uppercase tracking-wider text-base border-b-4 border-yellow-700 active:translate-y-1 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <LogIn className="w-5 h-5" />
            {busy ? 'Linking device…' : 'Link this device'}
          </button>
        </form>

        <button
          type="button"
          onClick={onSkip}
          className="mt-4 w-full py-3 rounded-xl border border-white/20 text-slate-300 font-black uppercase tracking-wider text-xs flex items-center justify-center gap-2"
        >
          <WifiOff className="w-4 h-4" />
          Work offline for now
        </button>
        <p className="mt-2 text-[11px] text-slate-500 font-semibold text-center">
          Records are kept on the device and upload once this device is linked.
        </p>
      </div>
    </div>
  );
}
