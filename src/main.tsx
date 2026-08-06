import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {migrateRecordIdsToUuid} from './services/idMigration';

// Must run before App mounts: the component reads records in its useState
// initialisers, so migrating afterwards would leave the UI holding stale ids
// while storage held new ones. Idempotent, so running on every boot is safe.
const migration = migrateRecordIdsToUuid();
if (migration.migrated > 0 || migration.orphaned > 0) {
  console.info(
    `[storage] migrated ${migration.migrated} record id(s) to UUID` +
      (migration.orphaned > 0
        ? `; ${migration.orphaned} record(s) kept but flagged as orphaned`
        : ''),
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
