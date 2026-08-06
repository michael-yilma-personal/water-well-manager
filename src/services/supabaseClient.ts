/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase connection.
 *
 * The URL and publishable key are baked into the bundle at build time. That is
 * safe only because Row Level Security is enabled on every table - the key
 * grants no access on its own. Never put an `sb_secret_...` key here; it would
 * ship inside the APK.
 *
 * The client is optional on purpose: the app must run fully offline, including
 * on a device that has never been configured, so nothing here may throw at
 * import time.
 */

// `import.meta.env` only exists under Vite. Reading it directly throws in a
// plain Node context such as the test runner, which would break importing any
// module that transitively touches this one.
const env: Partial<ImportMetaEnv> =
  (import.meta as ImportMeta & { env?: ImportMetaEnv }).env ?? {};

const url = env.VITE_SUPABASE_URL;
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY;

let client: SupabaseClient | null = null;

if (url && publishableKey) {
  client = createClient(url, publishableKey, {
    auth: {
      // Keep the driller signed in across app restarts and long stretches
      // offline; re-authenticating at a remote rig is not possible.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}

export function getSupabase(): SupabaseClient | null {
  return client;
}

/** False when the app has not been pointed at a project yet. */
export function isSupabaseConfigured(): boolean {
  return client !== null;
}

export const PHOTO_BUCKET = 'drilling-photos';
