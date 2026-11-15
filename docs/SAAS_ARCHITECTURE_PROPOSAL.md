# Drill — Multi-Tenant SaaS Architecture Proposal

Status: **proposal for review — nothing has been implemented.**
Assessed: 2026-11-12, against `main` at `2513737` plus the uncommitted working tree.

## Summary

- Drill already runs on Supabase (Postgres, Auth, Storage, one Edge Function) with Row Level Security as its real security boundary. That is the right foundation for multi-tenancy; nothing needs replacing.
- **Recommendation: build on the current stack (Options A and D, which are the same thing here).** Add an organization/membership/subscription layer in Postgres, enforced by RLS. Do not adopt Clerk or Better Auth: each would replace working authentication, force a rewrite of every policy, and still leave the tenancy, subscription and platform-admin work to be built.
- No new licences or services are required. One cost does need a decision: the Supabase **free tier is not a sound base for paying customers** (projects pause, no backups, 1 GB of photo storage across all tenants). See Decision 2.
- Estimated effort: roughly **17–26 working days** across six phases. The first milestone (Phase 1) adds tenancy to the database with no visible change to the apps.

---

## 1. Current application architecture

### 1.1 Stack

| Layer | What is there |
|---|---|
| Front end | React 19, TypeScript, Vite 6, Tailwind 4. One codebase, two Vite entry points: `index.html` (field app) and `admin.html` (office dashboard). |
| Mobile | Capacitor 8 Android wrapper, app id `com.jaguarsllc.drillpro`, version 1.1.7 (versionCode 9). |
| Back end | Supabase only. There is **no application server**. The browser/APK talks to PostgREST, Supabase Auth and Storage directly with the publishable key. |
| Server code | One Deno Edge Function, `supabase/functions/admin-users`, which holds the service-role key for account management. |
| Database | Postgres, six SQL migrations in `supabase/migrations/`. |
| Hosting | Field app web build: uploaded by hand to Hostinger (`77builders.com/drill/`). Dashboard: Netlify (`netlify.toml`). APK: built locally. Supabase: free tier, with a GitHub Actions keep-alive ping. |

`express`, `@google/genai` and `dotenv` are in `package.json` but nothing in `src/`, `supabase/` or `scripts/` imports them; they look like leftovers from the project template.

### 1.2 Authentication and user management

- Supabase Auth, email + password, via `signInWithPassword` (`src/services/auth.ts`). Public signup is disabled; accounts are provisioned.
- Sessions persist and refresh on the device so a crew can work offline for long periods. The write path never needs a live session: records are queued locally and the author is stamped when the queue drains.
- `public.profiles` (one row per auth user: `name`, `role`, `badge_number`) is created by a trigger on `auth.users`.
- Administrators manage accounts in the dashboard's Crew view, which calls the `admin-users` Edge Function: list, create (the admin sets the password), change role, deactivate (a ban) or delete, reactivate.
- The first administrator is created with `scripts/create-user.sh`.
- There is no email flow of any kind (no invitations, no password reset) and no way to change your own password in the app.

### 1.3 Data model

Four record tables, all with client-generated UUID keys, `created_by`, `recorded_at`, `received_at`, `modified_at`, and soft delete (`deleted_at`):

`boreholes` → `pipe_records`, `drilling_events`, `shift_logs` (each child has `borehole_id`).

Photos live in the private Storage bucket `drilling-photos` under `<user id>/<file name>`; the row stores only the file name.

**Every row is associated with a user, and only with a user.** `created_by` is the sole ownership concept. There is no crew, company or organization column anywhere.

### 1.4 Authorization

Global roles in `profiles.role`: Driller, Data Logger, Supervisor, Administrator. Enforced in RLS through two helper functions, `is_admin()` and `is_reviewer()`:

| Role | Reads | Writes |
|---|---|---|
| Driller, Data Logger | Own rows | Own rows |
| Supervisor | **Every row in the database** | Own rows; may correct End Pipe fields on anyone's pipe record |
| Administrator | **Every row in the database** | No field data; may correct End Pipe fields; manages accounts |

Sound hardening is already in place: roles cannot be self-assigned, `profiles.role` is not self-editable, DELETE is revoked, a trigger restricts which columns a reviewer can change, and the service-role key never leaves the Edge Function.

### 1.5 Tenant, subscription, billing

**None exists.** A search of `src/` and `supabase/` finds no organization, tenant, plan, subscription or billing concept. The system is effectively a single-tenant deployment: "Administrator" and "Supervisor" mean *of the whole database*, and `admin-users` lists and manages every account in the project.

### 1.6 Tests and security mechanisms

- 130 unit tests (`npm test`), all passing at the time of assessment. They cover the outbox, sync transports, mappers, merge and reports.
- 23 Python end-to-end suites in `e2e/`, including `rls_e2e.py`, which signs in as real accounts and attacks the policies over HTTP. This is a good pattern to extend for tenant isolation.
- The e2e suites run against the **live production project**, with the project URL hard-coded and test accounts created in the production user table.
- `npm run lint` is `tsc --noEmit`.

### 1.7 Findings worth knowing before starting

These are not part of the SaaS work, but they affect it.

1. **Supervisors and Administrators read across everything.** Harmless with one company; it is the main thing that must change.
2. **`admin-users` is global.** It lists all auth users (capped at 200), and deactivation is an account-level ban. A user in two companies would be locked out of both.
3. **Photo paths are keyed by user, not company.** A user who belongs to two companies would mix both companies' photos in one folder.
4. **The photo read policy still uses `is_admin()`.** According to the migrations, Supervisors gained record access in `20260928000000` but not photo access. Worth confirming against the live project.
5. **README "Known gaps" is stale**: it says Supervisor grants nothing, which that same migration changed.
6. **Tests run on production.** Tenant-isolation tests create organizations and attack them; that should not happen next to customer data.
7. **A rejected write is parked.** The outbox treats Postgres error `42501` as permanent. If a lapsed subscription returned `42501`, field records would be parked rather than retried. The design below accounts for this.
8. **Uncommitted work in the tree** (unsupported-browser gate, version bump). It should be committed before a schema-wide change starts.

---

## 2. Existing functionality that can be reused

| Existing piece | Reuse |
|---|---|
| Supabase Auth, sessions, offline identity cache | Unchanged. |
| RLS-first security model and helper-function pattern | Same pattern, with an organization argument added. |
| `profiles` table and signup trigger | Kept as the global identity (name). Role and badge move to the membership. |
| `admin-users` Edge Function | Becomes the organization-scoped members function. Its caller check, validation and delete-vs-deactivate rule carry over. |
| Crew view in the dashboard | Becomes the organization's member management screen. |
| `rls_e2e.py` and the e2e harness | Template for the tenant-isolation suite. |
| Offline outbox, pull by `created_by`, soft deletes, `modified_at` | Unchanged; they gain an `org_id`. |
| Vite multi-entry build | A third entry point hosts the platform console. |
| Account-switch rule (sign-out refused while work is unsent) | Reused as the rule for switching organization on a device. |

---

## 3. Comparison of the four options

Facts about Clerk and Better Auth were checked against their official pages on 2026-11-12 (sources at the end). Items I could not verify are marked.

### Option A — Extend existing infrastructure (Supabase Auth + Postgres RLS)

Add organizations, memberships, plans and subscriptions as tables; scope RLS by organization; make the Edge Function organization-aware; add a platform console.

### Option B — Clerk free tier

Current free ("Hobby") plan, per Clerk's pricing page: 50,000 monthly retained users per app, 100 monthly retained organizations, **up to 20 members per organization**, invitations included. Custom roles, unlimited members and verified domains need the "B2B Authentication Enhanced" add-on at $100/month. Organizations beyond 100 cost $1/month each.

Fit with Drill:

- The 20-member cap is exactly the stated maximum company size, so the largest customer would sit on the limit.
- Drill has four roles. Clerk's free tier does not include custom roles, so Drill's roles would still live in our own database.
- Clerk replaces Supabase Auth. Every policy uses `auth.uid()` and every table has a `created_by uuid` foreign key to `auth.users`; Clerk user ids are not UUIDs. All policies, the foreign keys, the profile trigger and the Edge Function would be rewritten, and every existing user migrated.
- The field app depends on long offline periods with a persisted Supabase session. Clerk sessions are short-lived tokens refreshed against Clerk's servers. How that behaves offline inside a Capacitor WebView was **not verified** and is the largest risk.
- Clerk provides nothing for manual subscriptions, platform administration or data isolation. Those are still built by us.

### Option C — Better Auth

Open-source TypeScript auth framework. Its organization plugin provides organizations, members, invitations (you send the emails yourself), an active organization on the session, and role/permission checks. It adds `organization`, `member` and `invitation` tables.

Fit with Drill:

- Better Auth runs inside **your own server**. Drill has none; one would have to be added and hosted.
- It also replaces Supabase Auth, with the same consequences as Clerk: `auth.uid()`-based RLS stops working unless we mint Supabase-compatible tokens ourselves, and all users are migrated (Better Auth publishes a Supabase migration guide).
- Its organization checks run in application code. Drill's clients talk to the database directly, so isolation must be in RLS regardless.
- It would be a reasonable choice for a future app that has a Node server and does not use Supabase.

### Option D — Minimal custom implementation

With this stack, "minimal custom" means Postgres tables, RLS policies and one Edge Function — which is Option A. The only real difference is ambition: D stops at what Drill needs; A names the reusable boundary. The recommendation is A built to D's size.

### Side by side

| Criterion | A / D — current stack | B — Clerk | C — Better Auth |
|---|---|---|---|
| Compatibility | Native. No auth change. | Poor: replaces auth; ids change type; offline behaviour unverified. | Poor: needs a server Drill does not have; replaces auth. |
| Effort | 17–26 days total | Similar tenancy work **plus** auth migration (est. +8–12 days) | Similar tenancy work **plus** server and auth migration (est. +10–15 days) |
| Security | One boundary (RLS), already tested this way | Two systems to keep consistent (Clerk org ↔ our rows) | Two systems; isolation still needs RLS |
| Cost | No new cost | Free up to 20 members/org and 100 orgs; $100/month beyond the member cap | Free (open source) plus hosting a server |
| Maintenance | SQL and one function; same skills as today | Vendor SDK upgrades, webhooks to sync users | A self-hosted auth server to patch and run |
| Lock-in | Supabase (already chosen); plain Postgres underneath | High: identities and org data live at Clerk | Low |
| Reusable elsewhere | Any Supabase app | Any app, at Clerk's limits | Any app with a server |
| Migration risk | Low: additive schema, backfill, old builds keep working | High: every user and device re-authenticates | High |

**Recommendation: Option A, kept minimal.** Existing infrastructure is sufficient. The third-party products solve authentication, which Drill has already solved, and do not solve isolation, subscriptions or platform administration, which is the actual work.

---

## 4. Recommended architecture

One Supabase project, one shared schema, every tenant-owned row carrying an `org_id`, isolation enforced by RLS.

```
 Field app (APK / web)      Office dashboard        Platform console
        │                         │                        │
        └────── Supabase Auth (unchanged) ─────────────────┘
                          │  JWT: auth.uid()
        ┌─────────────────┴──────────────────┐
        │  PostgREST + Storage, guarded by RLS│
        │   is_org_member(org_id)             │
        │   has_org_role(org_id, …)           │
        │   org_access(org_id)                │◄── subscription state
        └─────────────────┬──────────────────┘
                          │
   Edge Function `saas-members`      SQL functions (platform admin)
   (creates accounts; service key)   (create org, set subscription; audited)
```

Design choices and why:

1. **Shared schema with `org_id`, not a database or project per tenant.** Dozens of small tenants, one migration path, and the free/low tier allows only a couple of projects.
2. **Membership is looked up in the database on each request, not carried in the JWT.** A custom-claims token hook would save a lookup but leave a deactivated member with access until their token refreshes. At this scale the lookup costs nothing and revocation is immediate.
3. **The active organization is chosen by the client and verified by the server.** The client sends `org_id` on writes and filters; RLS checks membership. There is no server-side "current organization" to get out of sync, and a tampered `org_id` simply fails the membership check.
4. **Subscription state is evaluated inside RLS.** A lapsed or suspended organization is refused at the database, not just hidden in the UI.
5. **"Expired" is derived from dates, not stored.** No scheduled job has to run for a subscription to lapse.
6. **Platform administration is SQL functions, not a service.** Each function checks `is_platform_admin()`, makes its change and writes the audit row in the same transaction. Only account creation needs the Edge Function, because only that needs the service-role key.

---

## 5. Proposed schema changes

Names are indicative. All new tables have RLS enabled.

### 5.1 Reusable foundation tables

```sql
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id       uuid not null references public.organizations (id),
  user_id      uuid not null references auth.users (id),
  role         text not null,            -- vocabulary is set by the app (see 5.3)
  status       text not null default 'active'
                 check (status in ('invited', 'active', 'deactivated')),
  badge_number text,
  created_at   timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.platform_admins (
  user_id uuid primary key references auth.users (id)
);                                        -- rows are added by SQL only

create table public.plans (
  id        text primary key,             -- 'trial', 'standard', …
  name      text not null,
  max_users integer not null,
  features  jsonb not null default '{}',
  is_active boolean not null default true
);

create table public.subscriptions (
  org_id             uuid primary key references public.organizations (id),
  plan_id            text not null references public.plans (id),
  status             text not null
                       check (status in ('trial', 'active', 'suspended', 'canceled')),
  starts_at          timestamptz not null default now(),
  ends_at            timestamptz,         -- null = no end date
  grace_days         integer not null default 7,
  max_users_override integer,
  features_override  jsonb,
  notes              text
);

create table public.audit_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  actor_id uuid,
  org_id   uuid,
  action   text not null,                 -- 'org.create', 'subscription.extend', 'member.deactivate', …
  target   text,
  details  jsonb
);                                        -- insert only; no update or delete grant
```

One subscription row per organization holds the current state; its history is the audit log. That avoids a second history table.

### 5.2 Reusable helper functions

All `stable`, `security definer`, with a fixed `search_path`, like today's `is_admin()`.

| Function | Returns |
|---|---|
| `is_org_member(org)` | The caller has an **active** membership in `org`. |
| `has_org_role(org, variadic roles)` | Active membership with one of the given roles. |
| `org_access(org)` | `'full'`, `'read_only'` or `'none'`, from the subscription (section 8). |
| `is_platform_admin()` | The caller is in `platform_admins`. |
| `my_organizations()` | For the client: each organization the caller belongs to, with role, access level and end date. |

### 5.3 Drill-specific changes

- Add `org_id uuid not null references organizations` to `boreholes`, `pipe_records`, `drilling_events`, `shift_logs`, with an index on each.
- Child tables take their `org_id` **from the parent borehole** in a `before insert` trigger, so a client cannot attach a pipe record to one organization and label it another. `org_id` is immutable after insert.
- Constrain `memberships.role` to Drill's vocabulary (Driller, Data Logger, Supervisor, Administrator). Another app would add its own constraint; the foundation does not hard-code role names.
- `profiles.role` and `profiles.badge_number` are kept and mirrored during the transition so installed builds keep working, then dropped (Phase 5).
- Replace `is_admin()` / `is_reviewer()` in policies with organization-scoped checks:

```sql
-- Shape of the record policies (same for all four tables)
select: is_org_member(org_id)
        and org_access(org_id) <> 'none'
        and (created_by = auth.uid()
             or has_org_role(org_id, 'Supervisor', 'Administrator'))

insert: created_by = auth.uid()
        and has_org_role(org_id, 'Driller', 'Data Logger', 'Supervisor')
        and org_access(org_id) = 'full'

update: same as today (author, or reviewer for pipe corrections),
        each branch scoped to org_id, and org_access(org_id) = 'full'
```

- `profiles` select: own row, or a profile that shares an organization with the caller (today reviewers can read every profile).
- Photo storage: new path `<org_id>/<user_id>/<file>`, with policies checking membership of the first path segment. Existing objects under `<user_id>/` all belong to the founding organization and stay readable by that organization's reviewers only.

---

## 6. Authentication and authorization approach

**Authentication: unchanged.** Supabase Auth, email and password, persisted sessions. A user is one global account; belonging to companies is expressed by memberships. Public signup stays disabled.

**Authorization has three levels**, all enforced in the database:

| Level | Who | Decided by |
|---|---|---|
| Platform | Platform administrator (you) | `platform_admins` |
| Organization | Organization administrator; members | `memberships.role`, `memberships.status` |
| Record | Author vs reviewer | `created_by`, as today |

Role meanings stay as they are, but **per organization**: an Administrator of company A is nobody in company B. A user can be a Driller in one company and a Supervisor in another.

**Organization switching.** After sign-in the client calls `my_organizations()`.

- One membership: no switcher is shown.
- Several: the dashboard shows a switcher; the choice is remembered locally.
- Field app: a device works for one organization at a time. Switching is refused while unsent work is queued and clears local records, exactly as signing out does today. Each queued record carries the `org_id` it was created under, so nothing can be uploaded to the wrong company.

**Platform administrators do not get access to tenants' drilling data** through the apps. The platform console shows organizations, members and subscriptions only. Support access, if ever needed, is a deliberate act (adding a membership), and is audited. See Decision 6.

---

## 7. Organization lifecycle and membership management

**Organization lifecycle (platform administrator)**

1. Create the organization and its subscription (plan, trial or active, end date).
2. Create its first Administrator (email, name, temporary password).
3. From then on, the organization's Administrator manages their own members.
4. Suspend, reactivate, extend, change plan or cancel from the platform console. Each action is audited.

**Membership (organization administrator), via the `saas-members` Edge Function**

| Action | Behaviour |
|---|---|
| Add a new person | Creates the auth account with a temporary password and an `active` membership. Refused when the plan's user limit is reached. |
| Add someone who already has an account | Creates a membership only. **Never touches their password or account**, since that account may belong to another company. |
| Invite by email (Phase 5, optional) | Supabase sends the invitation; membership is `invited` until first sign-in. Needs an SMTP sender configured. |
| Change role | Updates the membership. You cannot change your own role; an organization must keep at least one Administrator. |
| Deactivate | Membership becomes `deactivated`: no access to this organization, records stay attributed, other organizations unaffected. Replaces today's account-wide ban. |
| Reactivate | Back to `active`, subject to the user limit. |
| Remove | Deleted if the member authored nothing in this organization; otherwise deactivated, as today. The auth account itself is never deleted by an organization. |

The function resolves the organization from the request, confirms the caller is an active Administrator **of that organization**, and only ever lists or changes members of it.

The user limit counts `active` and `invited` memberships and is enforced by a database trigger as well as by the function, so it cannot be bypassed by a direct insert.

---

## 8. Manual subscription lifecycle and access rules

**Stored status:** `trial`, `active`, `suspended`, `canceled`.
**Derived:** `expired` — a `trial` or `active` subscription whose `ends_at` plus `grace_days` has passed.

| State | Sign in | Read and export | Field uploads and edits | Manage members |
|---|---|---|---|---|
| Trial, before end date | Yes | Yes | Yes | Yes |
| Active, before end date | Yes | Yes | Yes | Yes |
| Past end date, within grace | Yes, with a renewal notice | Yes | Yes | Yes |
| Expired | Yes | Yes | **No** | Deactivate only |
| Suspended | Yes, to a "suspended" notice | No | No | No |
| Canceled | Yes, to a "canceled" notice | No | No | No |

`org_access()` maps these to `full`, `read_only`, `none`.

**Field data is never lost to a lapse.** A crew can be offline for days and return to an expired subscription. Writes refused for subscription reasons return a distinct error code; the app holds those records in the queue and uploads them after renewal, rather than parking them as it does for a genuine permission error. Already-installed builds will park such records, and the existing "retry parked" action recovers them.

**Platform administrator actions** (each a SQL function, each audited): start trial, activate, extend to a date, change plan, override user limit or features, suspend, reactivate, cancel.

**Entitlements.** `plans.features` (with a per-organization override) is a small JSON map, for example `{"photos": true, "excel_export": true}`. Features with a server boundary (photo upload) are enforced in policy. Features that run entirely in the browser (PDF and Excel export) can only be gated in the UI; that is acceptable for a plan feature but is not a security control.

**No payments.** Nothing here talks to a payment processor. If one is added later, it would only call the same functions the platform console calls.

---

## 9. Migrating existing users and records

Everything in the database today belongs to one company. The migration makes that explicit, and is designed so that **phones in the field keep working without an update.**

1. **Before:** export a backup of the database and confirm the live schema matches the six migrations.
2. **Create the founding organization** with an open-ended `active` subscription.
3. **Create memberships** for every existing profile in that organization, copying `role` and `badge_number`. Banned accounts become `deactivated` memberships.
4. **Add `org_id` as nullable**, backfill every existing row with the founding organization, verify zero nulls, then set `not null`.
5. **Compatibility for installed builds.** Old builds do not send `org_id`. A `before insert` trigger fills it: children from their parent borehole; boreholes from the author's membership when they have exactly one. Old builds read `profiles.role`; it stays mirrored from the membership. Old photo paths stay valid for the founding organization.
6. **Switch the policies** to the organization-scoped versions in the same migration as step 4, so there is no window with `org_id` present but unenforced.
7. **Verify** with the isolation suite and a manual check on a device running the currently released APK (1.1.7).
8. **Later (Phase 5):** once all devices are on a tenant-aware build, remove the compatibility trigger for boreholes and drop `profiles.role` / `profiles.badge_number`.

Rollback: steps 2–4 are additive. The policy switch is reversible by re-applying the previous policy definitions, which will be kept as a down script next to the migration.

Rule until step 8: **new organizations get the new build only**, and existing founding-organization users are not added to a second organization, because the old-build fallback needs exactly one membership.

---

## 10. Security considerations

**Principles**

- RLS remains the single enforcement point. The publishable key is in every APK; nothing in the client is trusted, including the `org_id` it sends.
- Every table in `public` either has an `org_id` with organization policies, or is on a short reviewed allowlist (`profiles`, `plans`, `platform_admins`, …).
- Helper functions are `security definer` with a pinned `search_path`. The service-role key stays in the Edge Function.
- Platform-admin rights come only from `platform_admins`, which has no insert path through the API.
- Adding an existing account to an organization never changes that account's credentials (prevents cross-tenant account takeover).
- The audit log is insert-only and written in the same transaction as the action.

**Risks specific to this design**

| Risk | Mitigation |
|---|---|
| A new table is added later without `org_id` or RLS | Automated schema check fails the test run (below). |
| A member is removed but their token is still valid | Membership is checked per request; access ends immediately. |
| Mismatched `org_id` between a child and its borehole | Child `org_id` is set by trigger from the parent, never from the client. |
| Photo URL guessing across tenants | Bucket stays private; signed URLs can only be minted for paths the caller's organization owns. |
| Admin-set temporary passwords | Add change-password and reset in Phase 5; until then, as today. |

**Tenant-isolation testing**

A new suite, `e2e/saas/tenant_isolation_e2e.py`, in the style of `rls_e2e.py`: real sign-ins, real HTTP calls, no mocks. It provisions two organizations with a full set of roles each, plus one user who belongs to both, and asserts:

- For every tenant table and every verb: a member of A cannot select, insert, update or soft-delete B's rows — by listing, by direct id, or by sending B's `org_id`.
- A row cannot be moved between organizations; a child cannot be attached to another organization's borehole.
- A's Supervisor and Administrator see all of A and none of B.
- The dual-member user sees each organization's data only under that organization's id.
- A deactivated member, and any member of a suspended or canceled organization, reads nothing; an expired organization reads but cannot write.
- Storage: cannot read, upload to, or mint a signed URL for another organization's path.
- `saas-members`: A's Administrator cannot list, modify or reset B's members, including by passing B's user ids.
- Platform functions refuse everyone who is not a platform administrator.
- The user limit holds under direct inserts.
- **Schema check:** every table in `public` has RLS enabled and is either organization-scoped or allowlisted.

These tests should run against a **separate staging Supabase project**, not production (Decision 3).

---

## 11. Reusable components and folder structure

The foundation is kept in clearly separated folders inside this repository for now. When a second application starts, those folders are lifted into a template repository. A shared package or central service is not justified for two or three small apps.

```
supabase/
  migrations/
    <ts>_saas_core.sql            # reusable: organizations, memberships, platform_admins,
                                  #           audit_log, helper functions
    <ts>_saas_subscriptions.sql   # reusable: plans, subscriptions, org_access(), admin functions
    <ts>_drill_tenancy.sql        # Drill: org_id columns, backfill, policies, role vocabulary
  functions/
    saas-members/                 # reusable: member management (replaces admin-users)
    _shared/saas/                 # reusable: caller checks, audit helper
src/
  saas/                           # reusable; imports nothing from Drill
    api.ts                        #   my_organizations, members, subscription calls
    orgContext.ts                 #   active organization, switching
    access.ts                     #   full / read_only / none helpers
    components/                   #   OrgSwitcher, MembersView, SubscriptionNotice
  platform/                       # reusable: platform console (third Vite entry, platform.html)
  admin/  components/  services/  # Drill (uses src/saas)
e2e/
  saas/                           # reusable: isolation suite + schema check
docs/
  saas/ADOPTING.md                # how to drop the foundation into another Supabase app
```

Boundary rule, checked by a small test: files under `src/saas`, `src/platform`, `saas_*` migrations and `saas-members` never reference Drill tables or types. Drill depends on the foundation, never the reverse.

| Capability | Reusable as-is | App supplies |
|---|---|---|
| Authentication integration | Supabase client and session handling | — |
| Organization and membership model | Tables, helpers, `my_organizations()` | Role vocabulary |
| Role-based authorization | `has_org_role()` | Which roles may do what |
| Invitations and member management | `saas-members`, MembersView | Role labels |
| Subscriptions and entitlements | Tables, `org_access()`, admin functions | Plan list, feature keys |
| Platform administration | Console and audit log | — |
| Isolation tests | Harness and schema check | List of tenant tables |

This reuse assumes future applications also use Supabase (Decision 10).

---

## 12. Phased implementation plan

Estimates are working days for one developer using coding agents, including tests.

### Phase 0 — Preparation · 1 day · low complexity

- Commit the pending working-tree changes.
- Confirm the live schema matches the migrations; take a backup.
- Create a staging Supabase project and point the e2e suites at it through environment variables.

Acceptance: the existing unit and e2e suites pass against staging; production holds no test accounts.

### Phase 1 — Tenancy in the database · 3–5 days · high complexity ← **recommended first milestone**

- `saas_core` migration; `drill_tenancy` migration (founding organization, memberships, `org_id`, compatibility triggers, organization-scoped policies, photo policies).
- Tenant-isolation suite and schema check.

Acceptance:
- The released APK (1.1.7) and current dashboard work unchanged against the migrated database.
- The isolation suite passes with a second organization created by SQL.
- Every existing row has the founding `org_id`; row counts match the pre-migration backup.

### Phase 2 — Organization-aware apps · 4–6 days · medium–high complexity

- `saas-members` replaces `admin-users`; Crew view manages memberships.
- Clients load `my_organizations()`, send `org_id`, and store it with queued records; organization switcher; new photo paths.
- New APK release.

Acceptance:
- An Administrator sees and manages only their organization's members.
- A user in two organizations can switch; data never crosses.
- Deactivating a member in one organization leaves their other membership working.
- Offline capture → sync still passes on a device (`test:apk`).

### Phase 3 — Subscriptions and entitlements · 3–4 days · medium complexity

- `saas_subscriptions` migration; `org_access()` wired into policies; user-limit trigger.
- Notices in both apps; subscription-refused writes are held, not parked.

Acceptance:
- Each state in the section 8 table behaves as listed, verified by tests that set dates and statuses.
- Records captured offline during a lapse upload after renewal with nothing lost.
- The user limit cannot be exceeded.

### Phase 4 — Platform console and audit · 3–4 days · medium complexity

- `platform.html`: organizations list, create organization and first Administrator, members and dates, plan and status changes, suspend/reactivate, audit history.

Acceptance:
- A new company can be onboarded end to end from the console with no SQL.
- Every administrative action appears in the audit log with actor, time and details.
- Non-platform accounts cannot open or call any of it.

### Phase 5 — Onboarding polish and cleanup · 2–4 days · low–medium complexity

- Change-password and password reset; optional email invitations.
- Remove compatibility triggers; drop `profiles.role` and `profiles.badge_number`; update the README.

Acceptance: no supported build depends on the removed columns; a user can change their own password.

### Phase 6 — Extract the foundation · 1–2 days · low complexity (when a second app starts)

- Lift the reusable folders into a template repository; write `ADOPTING.md`.

Acceptance: a blank Supabase project plus the template passes the isolation suite.

---

## 13. Effort summary

| Phase | Days | Complexity | Main risk |
|---|---|---|---|
| 0 Preparation | 1 | Low | — |
| 1 Tenancy in the database | 3–5 | High | Policy rewrite on live data; old-build compatibility |
| 2 Organization-aware apps | 4–6 | Medium–high | Offline queue and organization switching |
| 3 Subscriptions | 3–4 | Medium | Lapse handling for offline devices |
| 4 Platform console | 3–4 | Medium | — |
| 5 Polish and cleanup | 2–4 | Low–medium | Email delivery setup |
| 6 Extraction | 1–2 | Low | — |
| **Total** | **17–26** | | |

Phases 1–3 are sequential. Phase 4 can start once Phase 1 is in. A second company can be onboarded manually (by SQL) after Phase 2; Phases 3 and 4 make that safe and repeatable.

---

## 14. Decisions requiring your approval

1. **Approach.** Build on Supabase (Option A, kept minimal); do not adopt Clerk or Better Auth. *Recommended: yes.*
2. **Hosting plan.** The free tier pauses projects (the keep-alive has not reliably prevented it), has no backups, and allows about 1 GB of storage — on the order of 1,700 photos across all customers. The work needs no new licence, but I recommend moving to Supabase's paid plan (listed at about $25/month) before the first paying customer. This is the one place "zero cost" and "commercially sound" pull apart. *Approve the paid plan, or accept the risk for a pilot period?*
3. **Staging project.** Run e2e and isolation tests on a separate free project rather than production. *Recommended: yes.*
4. **Expired behaviour.** Read-only with exports, field records held on the device, 7-day grace by default. The alternative is to keep accepting field uploads while expired and only block the dashboard. *Recommended: as proposed.*
5. **Roles.** Keep the four roles, per organization, with Administrator remaining unable to author field data. *Confirm, or say if an organization owner role distinct from Administrator is wanted.*
6. **Platform admin and tenant data.** Platform administrators cannot read customers' drilling records by default. *Recommended: yes.*
7. **Onboarding method.** Keep admin-set temporary passwords now; add email invitations in Phase 5. Email needs an SMTP sender (your Hostinger mailbox may be enough — to be verified). *Recommended: as proposed.*
8. **Founding organization.** Its name, and which account becomes the platform administrator. I suggest a dedicated platform account, separate from the current company administrator.
9. **Adding existing users.** An Administrator can add an existing account to their organization without that person accepting first. *Recommended: yes for now; an acceptance step can be added with email invitations.*
10. **Reuse assumption.** Future apps will also be on Supabase, and the foundation lives in this repository until the second app starts. *Confirm.*
11. **Old builds.** How long APK 1.1.7 must keep working after Phase 2 ships. This sets when Phase 5 cleanup can happen.
12. **Canceled organizations.** How long data is retained after cancellation, and whether the customer gets an export first.

---

## Sources

Checked 2026-11-12.

- Clerk pricing: https://clerk.com/pricing
- Clerk organizations: https://clerk.com/organizations
- Better Auth organization plugin: https://www.better-auth.com/docs/plugins/organization
- Better Auth Supabase migration guide: https://better-auth.com/docs/1.6/guides/supabase-migration-guide.md
- Supabase pricing: https://supabase.com/pricing

Supabase limits (storage, pausing, paid-plan price) were taken from search summaries of the pricing page and secondary guides rather than read directly; confirm them on the pricing page before deciding on item 2.
