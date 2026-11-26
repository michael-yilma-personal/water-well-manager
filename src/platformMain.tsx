import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PlatformApp from './platform/PlatformApp';
import { createPlatformApi } from './platform/api';
import { getSupabase } from './services/supabaseClient';
import type { UserRole } from './types';
import './index.css';

// Drill's wiring of the reusable platform console (`src/platform`), which names
// nothing of Drill: the connection, the title and the administrator role's
// name are supplied here.
const ADMIN_ROLE: UserRole = 'Administrator';

const api = createPlatformApi({
  getClient: getSupabase,
  fetch: (input, init) => fetch(input, init),
  functionsUrl: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`,
  apiKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
  adminRole: ADMIN_ROLE,
});

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <PlatformApp api={api} client={getSupabase()} title="Drill" />
    </StrictMode>,
  );
}
