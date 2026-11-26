/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createSaasApi } from '../saas/api';
import { getSupabase } from './supabaseClient';

/** The field app's wiring of the reusable organization client (`src/saas`). */
export const saas = createSaasApi({
  getClient: getSupabase,
  fetch: (input, init) => fetch(input, init),
  functionsUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`,
  apiKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
});
