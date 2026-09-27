/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSupabase } from '../services/supabaseClient';

/**
 * Crew management, routed through the admin-users Edge Function.
 *
 * Creating accounts needs the service-role key, which cannot ship in a browser
 * bundle, so none of this talks to the database directly - the function holds
 * the key and re-checks that the caller is an administrator on every request.
 */

export interface CrewMember {
  id: string;
  email: string;
  name: string;
  role: 'Driller' | 'Data Logger' | 'Supervisor' | 'Administrator';
  badgeNumber: string;
  createdAt: string;
  lastSignInAt: string | null;
  /** Sign-in blocked, but their drilling records still name them. */
  deactivated: boolean;
  /** How many rows they authored; decides delete vs deactivate. */
  records: number;
  isSelf: boolean;
}

async function call<T>(method: string, body?: unknown): Promise<T> {
  const client = getSupabase();
  if (!client) throw new Error('This build is not connected to a Supabase project');

  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired - sign in again');

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-users`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error ?? `Request failed (${res.status})`);
  }
  return payload as T;
}

export async function fetchCrew(): Promise<CrewMember[]> {
  const { users } = await call<{ users: CrewMember[] }>('GET');
  return users;
}

export async function addCrewMember(input: {
  email: string;
  password: string;
  name: string;
  role: string;
  badgeNumber: string;
}): Promise<void> {
  await call('POST', input);
}

/**
 * Remove someone.
 *
 * Returns what actually happened: an account with drilling records is
 * deactivated rather than deleted, because their rows record who did the work.
 */
export async function removeCrewMember(
  id: string
): Promise<{ action: 'deleted' | 'deactivated'; records: number }> {
  return call('DELETE', { id });
}

export async function reactivateCrewMember(id: string): Promise<void> {
  await call('PATCH', { id, action: 'reactivate' });
}

export async function changeCrewRole(id: string, role: CrewMember['role']): Promise<void> {
  await call('PATCH', { id, action: 'setRole', role });
}
