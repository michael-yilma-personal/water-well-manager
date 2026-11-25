/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { LogOut } from 'lucide-react';
import type { Membership } from '../saas/api';

// The same wording as the dashboard's, so support hears one description.
export const NO_ORG_MESSAGE = {
  'no-membership':
    'This account does not belong to any organization. Ask an Administrator to add you.',
  'invited-only':
    "You have an invitation waiting. Accept it to see that organization's records.",
  deactivated:
    'Your membership has been deactivated. Ask an Administrator of your organization to restore it.',
};

/**
 * Shown instead of the rig screens while no organization is active: either the
 * person has several and must choose, or has none and is told why.
 */
export function OrgScreen({
  message,
  memberships,
  onChoose,
  onAnswer,
  onSignOut,
  pendingCount,
}: {
  message: string;
  memberships: Membership[];
  /** Resolves to a reason when the choice was refused. */
  onChoose: (orgId: string) => string | null;
  onAnswer: (orgId: string, accept: boolean) => Promise<void>;
  onSignOut: () => void;
  /** Unsent work. Signing out is refused while any remains. */
  pendingCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (orgId: string, accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(orgId, accept);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white flex flex-col items-center justify-center p-5">
      <div className="w-full max-w-sm flex flex-col gap-3">
        <h1 className="text-2xl font-black tracking-tight">PERIPLUS DRILL</h1>
        <p className="text-sm text-slate-400 font-semibold">{message}</p>

        {memberships
          .filter((m) => m.status === 'active')
          .map((m) => (
            <button
              key={m.orgId}
              type="button"
              onClick={() => setError(onChoose(m.orgId))}
              className="p-3 rounded-lg border-2 border-white/20 bg-black text-left font-black"
            >
              {m.name}
              <span className="ml-2 text-xs text-slate-400 font-semibold">{m.role}</span>
            </button>
          ))}

        {memberships
          .filter((m) => m.status === 'invited')
          .map((m) => (
            <div
              key={m.orgId}
              className="p-3 rounded border border-blue-500/40 bg-blue-500/10 text-blue-200 text-sm font-bold flex items-center gap-3 flex-wrap"
            >
              <span>
                You have been invited to join {m.name} as {m.role}.
              </span>
              <button
                type="button"
                onClick={() => answer(m.orgId, true)}
                disabled={busy}
                className="px-3 py-1.5 rounded bg-[#FFD700] text-black text-xs font-black uppercase disabled:opacity-50"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => answer(m.orgId, false)}
                disabled={busy}
                className="px-3 py-1.5 rounded border border-slate-600 text-slate-300 text-xs font-black uppercase disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          ))}

        {error && (
          <p className="text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-2">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onSignOut}
          disabled={pendingCount > 0}
          className="self-start flex items-center gap-1.5 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-xs font-black uppercase disabled:opacity-50"
        >
          <LogOut className="w-4 h-4" /> Sign out
        </button>
        {pendingCount > 0 && (
          <p className="text-[11px] text-slate-500 font-semibold">
            {pendingCount} record(s) still uploading. They are kept on this phone.
          </p>
        )}
      </div>
    </div>
  );
}
