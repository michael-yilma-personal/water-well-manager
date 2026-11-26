/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createClient } from '@supabase/supabase-js';
import { createSaasApi } from '../saas/api';
import { getSupabase } from '../services/supabaseClient';

/** Fired on `window` when a request is refused: the caller's membership may have changed. */
export const FORBIDDEN_EVENT = 'saas-forbidden';

/** The dashboard's wiring of the reusable organization client (`src/saas`). */
export const saas = createSaasApi({
  getClient: getSupabase,
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 403) window.dispatchEvent(new Event(FORBIDDEN_EVENT));
    return response;
  },
  functionsUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`,
  apiKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
});

/**
 * A password-reset link lands on the dashboard with the recovery session in
 * the address (D5-2). It gets its own client that keeps nothing: the session
 * stored for the dashboard (and, on the same origin, the field app) is never
 * touched.
 */
const recoveryInUrl = typeof window !== 'undefined' && /[#&](type=recovery|error_code=)/.test(window.location.hash);
export const recoveryClient = recoveryInUrl && import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ? createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
      auth: { storageKey: 'drill-recovery-auth', persistSession: false, autoRefreshToken: false, detectSessionInUrl: true },
    })
  : null;

/** Where a reset link opens: this site's dashboard. */
export const dashboardUrl = () => new URL('admin.html', window.location.href).href;
