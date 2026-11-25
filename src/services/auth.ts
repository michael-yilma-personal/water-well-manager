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
 * trip. Crucially, nothing on the write path calls into this module: records
 * are stamped with the cached user id and queued, so a stale session delays an
 * upload but never blocks a driller from logging a pipe at the rig.
 */

const CACHED_USER_ID_KEY = 'wwdm_auth_user_id';
const CACHED_ORG_ID_KEY = 'wwdm_active_org';

export interface AuthProfile {
  id: string;
  email?: string;
  name?: string;
  role?: string;
}

/**
 * The signed-in user's id, preferring the live session but falling back to the
 * last known value.
 *
 * The fallback matters: a device that has been offline long enough for the
 * access token to expire still knows who it is, so queued rows keep the correct
 * author instead of being stamped with nobody.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const client = getSupabase();
  if (client) {
    const { data } = await client.auth.getSession();
    const id = data.session?.user?.id;
    if (id) {
      localStorage.setItem(CACHED_USER_ID_KEY, id);
      return id;
    }
  }
  return localStorage.getItem(CACHED_USER_ID_KEY);
}

/** Synchronous view of the cached identity, for stamping records on save. */
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

export async function signIn(email: string, password: string): Promise<AuthProfile> {
  const client = getSupabase();
  if (!client) throw new Error('This build is not connected to a Supabase project');

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  const user = data.user;
  if (!user) throw new Error('Sign-in returned no user');

  localStorage.setItem(CACHED_USER_ID_KEY, user.id);
  return {
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
