import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp';
import '../index.css';

// No id migration here: the dashboard is read-only and never touches the
// device-local storage the field app maintains.
// Absent when the support gate in admin.html has taken the page over for a
// browser that lacks an API the dashboard needs.
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <AdminApp />
    </StrictMode>,
  );
}
