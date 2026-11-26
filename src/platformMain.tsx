import { createClient } from '@supabase/supabase-js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PlatformApp from './platform/PlatformApp';
import { createPlatformApi } from './platform/api';
import type { UserRole } from './types';
import './index.css';

// Drill's wiring of the reusable platform console (`src/platform`), which names
// nothing of Drill: the connection, the title and the administrator role's
// name are supplied here.
const ADMIN_ROLE: UserRole = 'Administrator';

// The console's own client and stored session: signing in or out here never
// touches the session of the dashboard or the field app on the same origin.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const client = url && key
  ? createClient(url, key, { auth: { storageKey: 'drill-platform-auth', detectSessionInUrl: false } })
  : null;

const api = createPlatformApi({
  getClient: () => client,
  fetch: (input, init) => fetch(input, init),
  functionsUrl: `${url}/functions/v1`,
  apiKey: key ?? '',
  adminRole: ADMIN_ROLE,
});

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <PlatformApp api={api} client={client} title="Drill" />
    </StrictMode>,
  );
}
