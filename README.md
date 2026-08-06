# water-well-manager

Field data-capture for water well drilling crews. Pipe-by-pipe logging, downtime
and event tracking, lithology analytics and PDF/Excel reporting, built to work
with no connectivity and sync when signal returns.

Two front-ends share one codebase:

- **Field app** (`index.html`) — the phone at the rig. Offline-first; ships to
  Android via Capacitor.
- **Administrator dashboard** (`admin.html`) — a laptop view of every borehole
  reported from the field.

## Stack

React 19 · TypeScript · Vite · Tailwind 4 · Recharts · jsPDF · SheetJS ·
Capacitor 8 · Supabase (Postgres, Auth, Storage)

## Run locally

```bash
npm install
cp .env.example .env.local     # fill in your Supabase URL and publishable key
npm run dev                    # field app  http://localhost:3000
                               # dashboard  http://localhost:3000/admin.html
```

## How syncing works

Writes never touch the network on the UI path. Saving a record writes it to
`localStorage` and appends an operation to an **outbox**; a worker drains that
queue when connectivity allows. This matters at a rig: a driller must never wait
on, or be blocked by, a radio.

- **Record ids are UUIDs.** The server upserts on primary key, so a
  device-local counter would let two rigs collide and silently overwrite each
  other. Use `createRecordId()` — the outbox refuses to queue anything else.
- **Parents are queued before children.** The queue drains oldest-first, so a
  pipe record sent before its borehole is rejected by the foreign key.
- **Each item retries on its own schedule.** A 300 KB photo failing on a weak
  link must not hold up the 2 KB pipe records behind it.
- **Nothing is discarded.** An operation that exhausts its retries is *parked*
  with its payload intact, not dropped.
- **Deletes are soft.** This is an audit log; rows are marked, never removed.
- **Drains trigger** on enqueue (debounced), network-regained, app-resume, and
  the manual sync button.

Nothing syncs while the app is closed — Capacitor has no background sync without
extra plugins. A phone in a pocket catches up when it is next opened.

## Security model

RLS is enabled on every table and is load-bearing, not defensive: the
publishable key ships inside the APK, so the policies are the only thing between
that key and the data.

- Crews read and write **only their own rows**.
- Administrators read **everything** and can write **nothing** — this log backs
  client billing, so entries must come from the rig.
- Roles are assigned out of band. Signup cannot set one, and `profiles.role` is
  not self-editable (the table UPDATE grant is revoked; only `name` and
  `badge_number` are re-granted).
- Photos live under `<uid>/` in a private bucket; the folder prefix is the
  authorisation check.

Verify it at any time:

```bash
npm run test:rls
```

## Photos

Compressed to 1600px on capture, written to the filesystem (never
`localStorage`, whose ~5 MB quota one raw photo would exhaust), and uploaded as
their own queued operation. A 320px thumbnail is generated at the same time and
uploads first.

The database stores only the filename; the bytes live in Supabase Storage. A
2.4 MB source becomes roughly 570 KB plus a 15 KB thumbnail. The dashboard lists
thumbnails and fetches the full image only when one is opened, which is what
keeps egress inside the free tier.

## Android

```bash
npm run build
npx cap sync android          # required after adding any Capacitor plugin
cd android && ./gradlew assembleDebug
```

Debug and release are signed with different keys, so a device holding one must
**uninstall before installing the other** — `adb install -r` fails with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

Release builds need `android/keystore.properties` (git-ignored):

```properties
storeFile=<path/to/your.jks>
storePassword=<...>
keyAlias=<...>
keyPassword=<...>
```

Then `./gradlew assembleRelease` (APK) or `bundleRelease` (AAB for Play).
Bump `versionCode` in `android/app/build.gradle` for every update or installs
are rejected as downgrades.

## Tests

```bash
npm run lint            # tsc --noEmit
npm test                # 67 unit tests
npm run test:e2e        # rls, new-crew, offline sync, photos, dashboard
npm run test:apk        # offline capture -> sync on a connected device
npm run test:apk-photos # photo pipeline on a connected device
```

The e2e suites run against the **live** Supabase project in `.env.local` and
need the seeded test accounts. `test:apk*` need an emulator or device with the
debug build installed and `adb` on PATH.

## Before real use

- [ ] **Delete the test accounts** (`driller1@`, `driller2@`, `admin1@example.com`)
      and the boreholes they created. They exist so the e2e suites can run.
- [ ] **Provision real accounts.** Signup is disabled, so create users in
      Supabase → Authentication, then set the role:
      `update public.profiles set role='Administrator' where id='<uuid>';`
- [ ] **Back up `android/app/drillpro-release.jks`.** Lose it and you cannot
      ship updates to anyone who installed the release build.
- [ ] **Check backup retention** on your Supabase plan. This log backs client
      billing; free-tier retention may not be what you want.
- [ ] Free projects **pause after ~1 week of inactivity**, after which sync
      fails until the project is restored from the dashboard.
      `.github/workflows/keep-supabase-awake.yml` pings it every three days —
      add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` as repo secrets to
      enable it. It doubles as a health check: a red run means sync is already
      broken. Note GitHub disables scheduled workflows after 60 days of repo
      inactivity, and that this works around a limit meant to reclaim idle
      resources — a paid plan is the honest fix if the project matters
      commercially.

## Known gaps

- A saved photo is not viewable in the field app after the event is closed; the
  dashboard is where photos are reviewed.
- `admin.html` (~15 KB) is bundled into the APK. Harmless and RLS-protected,
  but it does not need to be there.
