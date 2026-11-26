/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Session } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';

/**
 * Authentication for a device that spends most of its life offline.
 *
 * The driller signs in once where there is signal. Supabase then persists a
 * refresh token and the app keeps working indefinitely without a network round
 * trip. Crucially, nothing on the write path waits on a session: a record is
 * queued with the cached organization, and its author is the account whose
 * session uploads it. A stale session delays an upload but never blocks a
 * driller from logging a pipe at the rig.
 */

const CACHED_USER_ID_KEY = 'wwdm_auth_user_id';
const CACHED_ORG_ID_KEY = 'wwdm_active_org';
const CACHED_ACCESS_KEY = 'wwdm_active_org_access';

export interface AuthProfile {
  id: string;
  email?: string;
  name?: string;
  role?: string;
}

/**
 * The live session's user id, or null when there is no session to send with.
 *
 * Never the cached id (RF-123): a request sent without a session is refused by
 * the server as a permission error, and queued work was given up on for it.
 * This id becomes the author (`created_by`) of what is uploaded.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  const id = data.session?.user?.id ?? null;
  if (id) localStorage.setItem(CACHED_USER_ID_KEY, id);
  return id;
}

/**
 * True when this device holds no session at all, so only signing in again can
 * upload. A session that merely cannot be refreshed right now (no network)
 * answers with an error and is not lost.
 */
export async function sessionLost(): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const { data, error } = await client.auth.getSession();
  return !data.session && !error;
}

/** The account this device was last linked to. It marks the device as linked; no record is stamped with it. */
export function getCachedUserId(): string | null {
  return localStorage.getItem(CACHED_USER_ID_KEY);
}

/**
 * The organization this device is working for, as last settled online.
 * Read synchronously when a record is queued, so the write path stays offline.
 */
export function getCachedOrgId(): string | null {
  return localStorage.getItem(CACHED_ORG_ID_KEY);
}

export function setCachedOrgId(orgId: string): void {
  localStorage.setItem(CACHED_ORG_ID_KEY, orgId);
}

/** That organization's subscription access as last read online; null until read, which counts as full. */
export function getCachedAccess(): 'full' | 'read_only' | 'none' | null {
  return localStorage.getItem(CACHED_ACCESS_KEY) as 'full' | 'read_only' | 'none' | null;
}

export function setCachedAccess(access: string | null | undefined): void {
  if (access) localStorage.setItem(CACHED_ACCESS_KEY, access);
  else localStorage.removeItem(CACHED_ACCESS_KEY);
}

/**
 * `holdsUnsentWork`: the outbox has pending or parked work. Another account
 * may then not sign in over the one this device is linked to (RF-124): the
 * author is stamped at upload, so the work would become theirs or be refused.
 *
 * `previousId` in the answer is the account the device was linked to before.
 */
export async function signIn(
  email: string,
  password: string,
  holdsUnsentWork = false
): Promise<AuthProfile & { previousId: string | null }> {
  const client = getSupabase();
  if (!client) throw new Error('This build is not connected to a Supabase project');

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  const user = data.user;
  if (!user) throw new Error('Sign-in returned no user');

  const previousId = localStorage.getItem(CACHED_USER_ID_KEY);
  if (holdsUnsentWork && previousId && previousId !== user.id) {
    // Only this device's new session: the cached identity and the queue stay.
    await client.auth.signOut({ scope: 'local' });
    throw new Error(
      'This device holds unsent work of another account, which must sign in first.'
    );
  }

  localStorage.setItem(CACHED_USER_ID_KEY, user.id);
  return {
    previousId,
    id: user.id,
    email: user.email ?? undefined,
    name: (user.user_metadata?.name as string) ?? undefined,
    role: (user.user_metadata?.role as string) ?? undefined,
  };
}

/**
 * Sign out, but keep queued work.
 *
 * Clearing the outbox here would silently destroy field measurements that have
 * not reached the server. The queue stays and drains once someone signs in
 * again.
 */
export async function signOut(): Promise<void> {
  const client = getSupabase();
  if (client) await client.auth.signOut();
  localStorage.removeItem(CACHED_USER_ID_KEY);
  localStorage.removeItem(CACHED_ORG_ID_KEY);
  localStorage.removeItem(CACHED_ACCESS_KEY);
}

/**
 * Undo a sign-in that could not be completed. On a device that was already
 * linked only the new session goes: the identity and organization it had stay
 * with its queued work (RF-127). A first link is signed out as before.
 */
export async function undoSignIn(previousId: string | null): Promise<void> {
  if (!previousId) return signOut();
  await getSupabase()?.auth.signOut({ scope: 'local' });
  localStorage.setItem(CACHED_USER_ID_KEY, previousId);
}

/**
 * The signed-in account's own profile row.
 *
 * This is who actually did the work. Pipe records used to take their operator
 * name from a local picker seeded with three hardcoded demo people, so a real
 * driller's work was attributed to "James Wanjala" - a person who does not
 * exist - while created_by recorded the true account. The drilling log and the
 * audit trail disagreed.
 */
export async function fetchMyProfile(): Promise<{
  id: string;
  name: string;
  role: string;
  badgeNumber: string;
} | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data: sess } = await client.auth.getSession();
  const uid = sess.session?.user?.id;
  if (!uid) return null;

  const { data, error } = await client
    .from('profiles')
    .select('id, name, role, badge_number')
    .eq('id', uid)
    .maybeSingle();
  // A failed read is not a missing profile, and the caller tells them apart.
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id as string,
    name: (data.name as string) ?? '',
    role: (data.role as string) ?? 'Driller',
    badgeNumber: (data.badge_number as string) ?? '',
  };
}

export async function getSession(): Promise<Session | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session;
}

/** True once the device has been provisioned, even if currently offline. */
export function isProvisioned(): boolean {
  return getCachedUserId() !== null;
}
