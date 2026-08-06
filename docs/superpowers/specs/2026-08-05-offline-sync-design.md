# Offline-first sync and admin reporting

**Date:** 2026-08-05
**Status:** Approved, phased implementation

## Problem

Drilling crews log data at remote rigs with no connectivity. Today everything
lives in `localStorage` on one phone: if the phone is lost the borehole log is
gone, and an administrator has no way to see field data at all.
`synchronizeWithCloud()` exists but is a simulation — it flips `synced: true`
locally and never makes a network call.

## Goals

1. Crews capture data offline indefinitely; it uploads when connectivity returns.
2. An administrator can read every borehole's reports at any time.
3. No login wall, spinner, or failed write at the rig.

## Non-goals

- Two-way sync. Each device authors its own boreholes and pushes up; it never
  pulls another device's edits. This removes conflict resolution entirely.
- Simultaneous editing of one borehole by several devices.
- Background upload while the app is closed (see Limitations).

## Architecture

```
Phone (Capacitor)                    Supabase                 Admin
┌──────────────────┐                ┌──────────────┐        ┌──────────┐
│ UI (unchanged)   │                │ Postgres     │        │ Web      │
│   ↓ writes       │   outbox       │  + RLS       │ ←reads │ dashboard│
│ storage.ts       │ ──drain────→   │ Storage      │        └──────────┘
│ outbox queue     │  on reconnect  │ Auth         │
│ localStorage     │                │              │
└──────────────────┘                └──────────────┘
```

The phone remains the system of record while offline. Supabase is the durable
store and the administrator's query surface. No UI code awaits the network.

## Data model changes

### Record IDs must be UUIDs

`createRecordId()` currently returns `` `${prefix}-${Date.now().toString(36)}-${seq}` ``
from a device-local counter. Two phones saving in the same millisecond produce
the same ID; because the server upserts on primary key, one rig would silently
overwrite another's record. Demo boreholes are worse — every install ships the
identical hardcoded `bh-2026-04`.

Switch to `crypto.randomUUID()`. This is what makes retries idempotent: replaying
an operation is harmless.

### Two timestamps

Store `recorded_at` (device clock) and `received_at` (server `now()`). Rig phones
drift, and a crew logging a week offline would otherwise produce a log that
cannot be ordered or trusted. Reports read `recorded_at`; sync bookkeeping reads
`received_at`.

### Soft deletes

This is an audit log. Hard deletes that propagate destroy history. Records gain
`deleted_at`; the app filters them out, the dashboard may show them struck
through.

### Schema

| Table | Key columns |
|---|---|
| `profiles` | `id` → `auth.users`, `name`, `role`, `badge_number` |
| `boreholes` | project, client, rig, target/current depth, GPS, `created_by` |
| `pipe_records` | FK → `boreholes`; source of truth for depth |
| `drilling_events` | FK → `boreholes` |
| `shift_logs` | FK → `boreholes` |

All tables carry `created_by`, `recorded_at`, `received_at`, `deleted_at`.

`boreholes.current_depth` is stored for convenience, but `pipe_records` is
authoritative — the dashboard recomputes rather than trusting a value a stale
device pushed.

### Row Level Security

RLS is enabled on every table and is not optional: the publishable key ships
inside the APK, so RLS is the only thing standing between that key and the data.

- Field users: `insert`/`update` rows where `created_by = auth.uid()`; `select`
  only their own rows.
- `admin` role: `select` everything; no write.

## Sync engine: append-only outbox

Every mutation appends an operation:

```ts
{ id, op: 'upsert' | 'delete' | 'upload', entity, entityId,
  payload, attempts, lastError, enqueuedAt }
```

A worker drains oldest-first while online, upserting on the record UUID.

Chosen over a dirty-flag scan because:

- Photo uploads need independent retry. A 300 KB upload failing on bad signal
  must not head-of-line block a 2 KB pipe record.
- Deletes leave nothing to scan, so a dirty-flag approach needs a tombstone list
  bolted on anyway.
- FIFO preserves causality: a borehole is enqueued before the pipe records
  referencing it, so the foreign key is satisfied without extra ordering logic.

Drain triggers: app foreground, network regained, and after each local write.

Connectivity comes from `@capacitor/network`, not `navigator.onLine` — the
latter reports "online" for a WiFi association with no route.

## Photos

Currently `readAsDataURL` puts base64 straight into the record in localStorage.
One 3 MB photo becomes ~4 MB of base64 against a ~5–10 MB quota; a couple of
shots corrupt all app storage.

New pipeline: compress on capture (max 1600px, JPEG ≈0.7, →200–400 KB), write
the file with `@capacitor/filesystem`, enqueue an `upload` op targeting a
Supabase Storage bucket. The record stores the storage path; URLs resolve on
read.

## Auth

Administrator creates accounts. The driller signs in once where there is signal;
Supabase persists a refresh token and the app then works offline indefinitely.
The existing local user list stays as the on-rig "who is operating" picker;
real identity comes from the session.

**Writes must not depend on auth at write time.** The app stamps `created_by`
from the persisted session when the record is created, then queues it. If the
session is stale after weeks offline, the drain fails and retries after refresh.
The driller never meets a login wall at the rig.

## Demo data

Every install seeds `bh-2026-04` with 19 pipe records and 3 events, using IDs
identical across devices. Syncing that would let crews overwrite each other on
one fake borehole.

Demo rows get an `is_demo` flag. The outbox refuses to enqueue them. First run
offers "start empty" or "keep the sample data locally".

## Migration of existing devices

Devices already hold records with `p-<base36>-<seq>` IDs. A one-time migration
rewrites IDs to UUIDs and updates the foreign keys that reference them
(`pipeRecords.boreholeId`, `events.boreholeId`, `shiftLogs.boreholeId`, the
active-timer map). Records that cannot be remapped are left local and flagged
rather than silently dropped.

## Admin dashboard

Separate small web app: sign in, list boreholes across all rigs, filter by
project/client/date, drill into pipe log and NPT, download PDF/XLS.

`reports.ts` is pure client-side jsPDF/SheetJS, so the dashboard reuses it
directly against server data — no server-side export work.

## Configuration

`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.local`
(gitignored); `.env.example` documents them. These bake into the APK at build
time, which is acceptable for a publishable key precisely because RLS is on.

Never commit `sb_secret_…`.

## Error handling

- Drain failures increment `attempts` and back off exponentially per item.
- An op exceeding a retry ceiling is parked and surfaced in the UI rather than
  discarded — data loss is never the fallback.
- The header's "N Offline" badge reads real outbox depth instead of the current
  `synced` flag scan.
- Auth failure during drain pauses the queue; it does not block local writes.

## Testing

- Unit: outbox enqueue/drain/backoff/parking; UUID migration including FK
  rewrites; demo-data exclusion.
- Integration: drain against a local Supabase (`supabase start`), including RLS
  denial cases — verify a field user cannot read another user's rows.
- E2E: extend `e2e/run_e2e.py` — log offline, restore network, assert rows land.

## Limitations

Nothing syncs while the app is closed. Capacitor has no background sync without
additional plugins; drain happens on foreground and reconnect. A phone in a
pocket does not upload overnight.

## Phases

1. UUIDs + device migration + outbox (no server).
2. Supabase schema, RLS, auth, drain worker, soft deletes.
3. Photo compression and upload pipeline.
4. Admin web dashboard.
