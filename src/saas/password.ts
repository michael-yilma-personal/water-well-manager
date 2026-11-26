/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Changing one's own password and resetting a forgotten one (D5-1, D5-2).
 * Only the client's `auth` is used. Every refusal is one sentence to show.
 */

type Auth = Pick<SupabaseClient['auth'], 'signInWithPassword' | 'updateUser' | 'resetPasswordForEmail'>;
type Client = { auth: Auth };

const asSentence = (s: string) => `${s.trim().replace(/[.!?]+$/, '').replace(/[.!?]/g, ',')}.`;

/** A sentence when the new password is refused, null when acceptable. `current` null skips "same as the current one". */
export function validateNewPassword(current: string | null, next: string, repeat: string, min = 8): string | null {
  if (next !== repeat) return 'The two new passwords do not match.';
  if (next.length < min) return `The new password must have at least ${min} characters.`;
  if (current !== null && next === current) return 'The new password must differ from the current one.';
  return null;
}

async function setPassword(client: Client, next: string): Promise<void> {
  const { error } = await client.auth.updateUser({ password: next });
  if (error) throw new Error(asSentence(`The password was not changed: ${error.message}`));
}

/** Checks `current` by signing in with it, then sets the new one. Nothing is signed out. */
export async function changePassword(client: Client, email: string, current: string, next: string, repeat: string): Promise<void> {
  const refused = validateNewPassword(current, next, repeat);
  if (refused) throw new Error(refused);
  const { error } = await client.auth.signInWithPassword({ email, password: current });
  if (error) {
    throw new Error(error.status === 400 ? 'The current password is not correct.' : asSentence(`The current password could not be checked: ${error.message}`));
  }
  await setPassword(client, next);
}

const RESET_SENT = 'If an account uses this address, an email with a link to set a new password is on its way.';

/** Sends the reset email. The answer is the same whatever the server said (RF-167): it never tells known addresses apart. */
export async function requestReset(client: Client, email: string, redirectTo: string): Promise<string> {
  if (!email.trim()) return 'Enter your email address.';
  await client.auth.resetPasswordForEmail(email.trim(), { redirectTo });
  return RESET_SENT;
}

/** Sets the new password of a password-recovery session: the same rules, no current password. */
export async function setRecoveredPassword(client: Client, next: string, repeat: string): Promise<void> {
  const refused = validateNewPassword(null, next, repeat);
  if (refused) throw new Error(refused);
  await setPassword(client, next);
}
