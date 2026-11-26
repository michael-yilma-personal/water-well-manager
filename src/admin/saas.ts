/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

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
