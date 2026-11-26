# Drill SaaS — Implementation Status

Requirements: `docs/SAAS_ARCHITECTURE_PROPOSAL.md`. How the work is run: `docs/saas/WORKFLOW.md`.

## Current state

- **Phase:** Phases 3 and 4 are done on staging (approved 2026-11-25). Phase 5 (onboarding polish and cleanup) and Phase 6 are **not approved**. Nothing from Phases 1 to 4 is on production. No push to `main` (owner, 2026-11-25): `main` is updated together with the production migration.
- **Branches:** pull requests 3 (tooling), 4 (Phase 0), 5 (Phase 1), 6 (Phase 2), 7 (Phase 3) and 8 (Phase 4), each based on the one before, await the owner's merge in that order.
- **Phase 4 is done on staging** (TEST_RESULTS 103 to 116): `saas_platform` applied, `saas-members` deployed, the console at `platform.html`; reviews SR26 and SR27, no blocking finding left. Open for the owner: which account is the platform administrator on production (D4-2; remove its founding membership after creating it, RF-160) and where the console is hosted (not on the Hostinger field-app site, RF-162).
- **Phase 3 is done on staging** (TEST_RESULTS 92 to 102): tasks P3-1 to P3-4; both migrations applied to staging, `saas-members` and `admin-users` redeployed there; five reviews (SR21, SR23, SR24, SR25 and the session-loss rounds), no blocking finding left. Not run for Phase 3: the APK on a device or emulator. The field app's version is still 1.2.0.
- **Open for the owner from Phase 3:** RF-143 (phones on 1.1.7 can lose records captured during a lapse: update the phones or accept it before any organization gets an end date); RF-152 (held work that will never be renewed leaves no exit: export and discard, or keep blocking); the real plans and user limits (D3-6 seeds one plan of 100 users). The upgrade test on a real phone is last (owner, 2026-11-25).
- **Next step:** plan Phase 4 and run its tasks one after the other without asking (owner, 2026-11-25).
- **Manual testing on staging (owner, 2026-11-26):** done. Test Company B, its memberships, subscription and audit rows, `platform1@example.com` (and its `platform_admins` row), `adminb`, `drillerb` and `drillerab` were removed afterwards by the Lead; staging holds the founding organization and the five kept accounts again (TEST_RESULTS 118).
- **Phase 1** is done on staging; its production migration is **not approved**. **Do not check out `main` or any branch that predates the tooling until the pull requests are merged (RF-059).**
- `.claude/settings.json`: found on 2026-11-25 (14:44) with every line commented out again, which turns the four hooks off (the same edit as on 2026-11-17). Not made by the Lead or an agent as far as known; left as found and not committed. While it stands the Stop gate and the Bash guard do not run: the Lead runs `scripts/gate.sh` by hand.
- **Waiting on the owner:** the production decision for Phase 1; the action recorded for RF-050 (deferred by the owner; does not block development); approval to delete the `probe` function from production (RF-049); confirmation of the staging rule (RF-054); branch protection on `main`; merging the three pull requests (RF-059).

## Phases

| Phase | Branch | Status | Pull request |
|---|---|---|---|
| Workflow setup | `chore/agent-workflow` | Done; CI green; awaiting the owner's merge | https://github.com/michael-yilma-personal/water-well-manager/pull/3 |
| 0 Preparation | `saas/phase-0-preparation` | Done; CI green; awaiting the owner's merge (after pull request 3) | https://github.com/michael-yilma-personal/water-well-manager/pull/4 |
| 1 Tenancy in the database | `saas/phase-1-tenancy` | Done on staging; awaiting the owner's review. **Production migration not approved** | https://github.com/michael-yilma-personal/water-well-manager/pull/5 |
| 2 Organization-aware apps | `saas/phase-2-org-apps` | Approved 2026-11-23; in progress on staging | — |
| 3 Subscriptions and entitlements | `saas/phase-3-subscriptions` | Done on staging; awaiting the owner's review. **Nothing on production** | https://github.com/michael-yilma-personal/water-well-manager/pull/7 |
| 4 Platform console and audit | `saas/phase-4-platform` | Done on staging; awaiting the owner's review. **Nothing on production** | https://github.com/michael-yilma-personal/water-well-manager/pull/8 |
| 5 Onboarding polish and cleanup | — | First half approved 2026-11-26 (staging only): change password, password reset. Email invitations wait for the owner's choice of sender; the cleanup (removing the compatibility code, which stops build 1.1.7) waits until the crews' phones run the new build | — |
| 6 Extract the foundation | — | Not approved | — |

## Tasks

### Workflow setup

| Id | Task | Status | Evidence |
|---|---|---|---|
| WF-1 | Agent definitions in `.claude/agents/` | Done | Files present |
| WF-2 | Gate scripts, hooks, CI workflow | Done | Hooks pipe-tested; see TEST_RESULTS |
| WF-3 | Workflow manual and progress files | Done | `docs/saas/` |
| DEMO-1 | Static migration check: every table created in `supabase/migrations/` has RLS enabled | Done: RF-001 to RF-006 fixed and verified by the second review | TEST_RESULTS 8, 11 |
| WF-4 | Harden the enforcement after the security review (RF-010 to RF-024) | Done; follow-ups in WF-5 | TEST_RESULTS 10 to 12 |
| WF-5 | Final fix round: validation failures and second-review findings (RF-025 to RF-037) | Done: verified by the third review | TEST_RESULTS 13, 14 |

### Phase 5 — Onboarding polish (first half approved 2026-11-26; staging only)

Requirement: proposal section 7 (onboarding) and the Phase 5 entry of section 12. Acceptance for this half, from the proposal: a user can change their own password; and a user who forgot it can set a new one without their Administrator.

Not in this half: email invitations (waiting for the owner's choice of sender); removing the compatibility triggers, `profiles.role`, `profiles.badge_number` and `admin-users` (stops build 1.1.7: only after every crew phone runs the new build); the README.

| Id | Task | Status | Evidence |
|---|---|---|---|
| P5-1 | Change your own password: in the field app (Rig Settings), the dashboard and the console | Not started | — |
| P5-2 | Password reset: "Forgot password?" on the sign-in screens; the emailed link opens a page that sets a new password | Not started | — |
| P5-3 | Phase suite on staging; the existing suites still pass; CI | Not started | — |

Criteria are written when each task starts.

#### Decisions taken by the Lead for Phase 5 where the proposal left it open (2026-11-26; each can be changed)

| Id | Decision |
|---|---|
| D5-1 | Changing a password asks for the current one, checked by signing in with it, and the new one twice. The person stays signed in on that device; nothing else is signed out. |
| D5-2 | The reset link from any app opens one page on the dashboard's site, which sets the new password; the person then signs in again in the app they use (the APK cannot receive the link itself). The sign-in screens never say whether an address has an account. |
| D5-3 | On staging, reset emails are not sent to real inboxes: the suites take the link from the Auth admin API. Production needs the dashboard's address in the Auth redirect list and a working sender (production checklist). |

### Phase 4 — Platform console and audit (approved 2026-11-25; staging only)

Requirement: proposal sections 4, 6, 7, 8 ("Platform administrator actions"), 10 and the Phase 4 entry of section 12. Phase acceptance, from the proposal: a new company can be onboarded end to end from the console with no SQL; every administrative action appears in the audit log with actor, time and details; non-platform accounts cannot open or call any of it.

Not in this phase: email invitations, password change and reset, removing the compatibility triggers (Phase 5); payments (never). A platform administrator is still added by SQL only (proposal 10).

| Id | Task | Status | Evidence |
|---|---|---|---|
| P4-1 | Reusable migration `saas_platform`: the platform administrator's SQL functions (create an organization with its subscription; change a subscription: start trial, activate, extend, change plan, override the user limit, suspend, reactivate, cancel), each checking `is_platform_admin()` and writing its audit row in the same transaction; the read paths the console needs (organizations with subscription and member counts, members of an organization, audit history) | **Done**: reviewed (SR26), RF-157 and RF-158 fixed and tested; **applied to staging** | TEST_RESULTS 103, 106, 109, 111 |
| P4-2 | Creating an organization's first Administrator through the Edge Function (the one step that needs the service role), for platform administrators only, audited | **Done**: reviewed (SR26), first Administrator only (D4-6); **deployed to staging** | TEST_RESULTS 104, 105, 110, 111 |
| P4-3 | The console: `platform.html` (third Vite entry) and `src/platform/`: sign-in, organizations list, create organization and first Administrator, members and dates, subscription actions, audit history | **Done**: `platform.html`, `src/platformMain.tsx`, `src/platform/api.ts`, `PlatformApp.tsx`; reviewed (SR27), RF-162 to RF-164 fixed; driven on staging by the suite | TEST_RESULTS 108, 112 |
| P4-4 | Phase suite on staging: onboarding end to end from the console, the audit trail, non-platform accounts shut out; the existing suites still pass; CI | **Done on staging**: new suite 33 of 33; existing suites green apart from tenant isolation, held while the owner's test company exists | TEST_RESULTS 114, 115, 116 |
| P4-5 | Leftovers: the field app offers a waiting invitation to someone who already works for a company (RF-161); the console's audit list shows emails, not ids | **Done**: reviewed (SR28), no blocking finding; `saas_platform_audit` **applied to staging** | TEST_RESULTS 119 |

Criteria are written when each task starts.

#### Decisions taken by the Lead for Phase 4 where the proposal left it open (2026-11-25; each can be changed)

| Id | Decision |
|---|---|
| D4-1 | Platform administrators see organizations, members (name, email, role, status) and subscriptions, never Drill records (proposal 6): nothing in Phase 4 adds a read path to a Drill table. |
| D4-2 | On staging the platform administrator is a test account the fixture adds to `platform_admins` through the database and removes afterwards. Which real account becomes the platform administrator on production is the owner's decision (proposal 14, item 8). |
| D4-3 | The console is plain and small: one page, the existing dashboard's styles, no new dependency. |
| D4-4 | No transition between subscription states is forbidden, and changing to a smaller plan is allowed (the user limit then only stops new members). `start_trial` takes an optional end date. The service role cannot call the platform functions: only a signed-in platform administrator can. |
| D4-5 | The audit rows of subscription changes carry the subscription before and after without `notes`: an organization's Administrators can read their own audit rows, and a note is for the platform administrator only. A change of note alone is therefore not in the history. |
| D4-6 | Through `saas-members` a platform administrator can add an organization's first Administrator only: refused once the organization has an active Administrator, and refused for the platform administrator's own email. Support access to an existing organization stays a deliberate act in SQL (proposal 6). |

#### P4-1 criteria (2026-11-25)

1. `platform_create_organization(name, plan, status, ends_at)` creates the organization and its subscription (trial or active) in one transaction with an `org.create` audit row; an unknown plan or another status is refused.
2. `platform_update_subscription(org, action, args)` with the actions start_trial, activate, extend, change_plan, override, suspend, reactivate, cancel, and optional notes; one audit row `subscription.<action>` with the values before and after; an unknown action, a missing argument or an organization without a subscription is refused.
3. Reads for the console: `platform_organizations()`, `platform_members(org)`, and the audit log through its existing policy.
4. Every function refuses a caller who is not a platform administrator with 42501; `anon` has no execute; `platform_admins` has no insert path through the API.
5. A platform administrator who is not a member reads no Drill record and cannot change an audit row.
6. An organization created by the function behaves like any other (access from its subscription, user limit).
7. The existing database suite stays green; the rollback restores the catalog exactly; the reusable boundary holds.

#### P4-2 criteria (2026-11-25)

1. A platform administrator who is not a member may add a member with the organization's administrator role through `saas-members`: a new email gets an account with the temporary password and an active membership; the actor recorded is the platform administrator.
2. An email that already has an account gets a membership only (`invited`, as when an organization's Administrator adds an existing account); the account is never touched.
3. Nothing else is open to a platform administrator there without a membership: any other role, listing, role change, deactivating, re-activating, removing are 403.
4. The organization's subscription and user limit still apply (402, 409); an unknown organization is refused.
5. Anyone who is neither a platform administrator nor an active Administrator of the organization still gets 403; an organization's Administrator is unaffected.

#### P4-3 criteria (2026-11-25)

1. `platform.html` is a third entry of the build. After sign-in an account that is not a platform administrator sees one sentence saying so and a way to sign out, and no data; an error answering "is this a platform administrator" is never taken as yes.
2. The organizations list shows each organization's name, plan, status, end date, access level and member count.
3. Creating an organization (name, plan, trial or active, optional end date) and its first Administrator (email, name, temporary password) is one flow with no SQL; a refusal shows the server's sentence.
4. An organization's page shows its members (name, email, role, status) and its subscription, with the actions start trial, activate, extend, change plan, override the user limit, suspend, reactivate and cancel, and a note; suspend and cancel ask for confirmation.
5. The audit history, for one organization and overall: time, actor, action, details.
6. `src/platform` is reusable: no Drill name in it; the administrator role's name comes from outside the folder. No new dependency.

### Phase 3 — Subscriptions and entitlements (approved 2026-11-25; staging only; starts after the Phase 2 gaps)

Requirement: proposal sections 5.1, 5.2, 8 and the Phase 3 entry of section 12. Phase acceptance, from the proposal: each state in the section 8 table behaves as listed, verified by tests that set dates and statuses; records captured offline during a lapse upload after renewal with nothing lost; the user limit cannot be exceeded.

Not in this phase: the platform console and the audited platform functions that change a subscription (Phase 4, where they are first used); payments (never). On staging a subscription is set by the test fixture.

| Id | Task | Status | Evidence |
|---|---|---|---|
| P3-1 | Reusable migration `saas_subscriptions`: `plans`, `subscriptions` (RLS on), `org_access(org)`, the user-limit trigger on `memberships`, `my_organizations()` returning access level and end date; a subscription row for every existing organization | **Done**: reviewed (SR21), findings fixed and tested; **applied to staging** | TEST_RESULTS 92, 94, 95, 98 |
| P3-2 | Drill migration `drill_subscriptions`: `org_access()` in the Drill policies and the photo bucket; a distinct error code for a write refused by the subscription; `saas-members` follows the "Manage members" column | **Done**: reviewed (SR23), RF-144 to RF-146 fixed and tested; **applied to staging**, `saas-members` and `admin-users` redeployed there. Open from the review: RF-143 (build 1.1.7, production only) | TEST_RESULTS 95, 97, 98 |
| P3-3 | Apps: notices in both (grace, expired, suspended, canceled); the field app holds subscription-refused work in the queue and uploads it after renewal; the dashboard is read-only when expired | **Done**: two review rounds (SR24, SR25), no blocking finding left; RF-149 to RF-154 fixed or decided; open for the owner: RF-152 | TEST_RESULTS 99, 101 |
| P3-4 | Phase suite on staging: the three phase acceptance points with real sign-ins; the existing suites still pass; CI | **Done on staging**: the nine existing suites unchanged and green; the new suite 53 of 53 | TEST_RESULTS 100 to 102 |

Criteria are written when each task starts.

#### Decisions taken by the Lead for Phase 3 where the proposal left it open (2026-11-25; each can be changed)

| Id | Decision |
|---|---|
| D3-1 | An organization without a subscription row has access `none` (fail closed). The migration gives every existing organization a row: plan `standard`, status `active`, no end date, so nothing changes for the founding organization. |
| D3-2 | The user limit counts `active` and `invited` memberships; `deactivated` ones do not count. Re-activating a member is checked like adding one. |
| D3-3 | The functions a platform administrator uses to change a subscription are written in Phase 4 with the console. In Phase 3 the tests set dates and statuses through the fixture. |
| D3-4 | Feature flags (`plans.features`) are stored but nothing is gated by them in Phase 3: no plan differs in features yet. |
| D3-5 | An organization without a subscription row has no user limit (its access is `none` anyway). |
| D3-6 | One plan is seeded, `standard`, with `max_users` 100. The real plans and limits are the owner's to set. |
| D3-7 | `plans` is on the allowlist of `schema_check.sql` (tables without `org_id`): it is a catalog shared by all organizations and holds no tenant data. |
| D3-8 | Clients do not read `subscriptions` directly (it holds `notes` and overrides meant for the platform administrator). The apps get `access` and `ends_at` from `my_organizations()`, for active memberships only. This replaces the first half of P3-1 criterion 1. |
| D3-9 | With an expired subscription an Administrator may list and deactivate members, nothing else (no removal, no badge change). A refusal for the subscription is HTTP 402; "not an Administrator" stays 403; the user limit is 409. |
| D3-10 | The apps show one notice for suspended and canceled ("this organization's subscription is not active"): `my_organizations()` gives the access level, not the stored status. |

#### P3-1 criteria (2026-11-25)

1. `plans` and `subscriptions` as in proposal 5.1, RLS on; an active member reads their own organization's subscription and the plans; no write through the API; no read of another organization's subscription.
2. `org_access(org)` returns `full`, `read_only` or `none` per section 8, and `none` without a row.
3. The user-limit trigger refuses with SQLSTATE `SS001`; deactivated memberships do not count; two concurrent inserts cannot both take the last seat.
4. `my_organizations()` also returns `access` and `ends_at`; existing callers unchanged.
5. Every existing organization gets a `standard`, `active` subscription without end date.
6. The existing database suite stays green; nothing is wired into a policy yet.
7. A rollback restores the previous state exactly.

#### P3-2 criteria (2026-11-25)

1. Inserting or updating Drill records succeeds only when the organization's access is `full`; trial, active and within grace behave as today.
2. A write refused by the subscription fails with SQLSTATE `SS002`, visible to the client as the error code; an ordinary permission refusal is still 42501.
3. With `full` or `read_only` everything readable today stays readable; with `none` a member reads no Drill records of that organization.
4. Photos: upload needs `full`; reading needs not `none`.
5. Signing in always works: `my_organizations()` lists the organization with its access in every state, and the caller's own profile is readable.
6. Managing members through `saas-members`: `full` as today; `read_only` only listing and deactivating; `none` nothing. The refusal is HTTP 402 with one sentence; "not an Administrator" stays 403.
7. The user-limit refusal (`SS001`) reaches the dashboard as HTTP 409 saying the plan's user limit is reached.
8. Records refused during a lapse are accepted unchanged after renewal.
9. One organization's subscription state never affects another's members or records.
10. The founding organization and every existing suite behave as before; the rollback restores the previous policies exactly; the reusable files stay free of Drill names.

#### P3-3 criteria (2026-11-25)

1. Both apps show a notice from the active organization's `access` and `ends_at`: past the end date but still `full` (grace) a renewal notice; `read_only` an expired notice; `none` a "subscription not active" screen with no data and a way to sign out or change organization. No notice for an organization in good standing.
2. Field app: a write refused with `SS002` is held: it stays queued, is not parked and uses no attempt; capture keeps working during the lapse; the held work uploads after renewal with nothing lost.
3. Field app: a photo refused while the organization's access is not `full` is held the same way, not parked.
4. Field app: a soft delete made while the organization's access is `none` is not taken as sent; it applies after reactivation (RF-142).
5. Dashboard, expired: reading and exporting work; editing records and adding, inviting, re-activating or changing members are not offered or show the server's sentence; deactivating a member works.
6. Dashboard: the user-limit refusal shows the server's sentence.
7. A device or browser that has no access level cached yet behaves as `full` until it has read one. The founding organization sees no change.
8. Field app: work held for the subscription blocks Sign Out and an organization switch as pending work does, and is never discarded (RF-143).

### Phase 2 — Organization-aware apps (approved 2026-11-23; staging only)

Requirement: proposal sections 4, 6, 7, 11 and the Phase 2 entry of section 12. Phase acceptance, from the proposal: an Administrator sees and manages only their organization's members; a user in two organizations can switch and data never crosses; deactivating a member in one organization leaves their other membership working; offline capture → sync still passes on a device (`test:apk`).

Not in this phase: plans, user limits and subscription state (Phase 3); the platform console and creating organizations from an app (Phase 4); email invitations (Phase 5). On staging a second organization is still created by the test fixture.

| Id | Task | Status | Evidence |
|---|---|---|---|
| P2-1 | Database support for member management: reusable migration `saas_members` and Drill migration `drill_members` | **Done**: every criterion has a passing check; the re-review (SR15) has no blocking finding; RF-105 deferred with the reviewer's agreement; **applied to staging** | TEST_RESULTS 66 to 77 |
| P2-2 | Edge Function `saas-members` with `_shared/saas`; handler tests in the gate; deployed to staging; authorization suite on staging | In progress: implemented (`handler.ts` 189 lines, `index.ts` 130), RF-110 to RF-112 fixed and tested; **deployed to staging** and answering correctly in a first live check; the staging suite (criterion 9) is being written | TEST_RESULTS 73 to 77 |
| P2-3 | Client foundation `src/saas` (`api.ts`, `orgContext.ts`) and the boundary test | Implemented (110 lines), unit tests and gate green; read by the Lead. Not yet used by an app: its validation and review happen with P2-4, its first use | TEST_RESULTS 71 |
| P2-4 | Dashboard: organization switcher, records and photos of the active organization, Crew view on `saas-members`, accepting an invitation | Implemented; full gate green (type check and build); not yet run in a browser: the staging suites are being written | TEST_RESULTS 77 |
| P2-5 | Field app: active organization, `org_id` on boreholes and queued work, new photo path, switching rules, role from the membership | Implemented; RF-114 to RF-116 verified fixed by the re-review; RF-119 fixed and tested; no open High or Medium. **Not yet run in a browser or on a device**: the staging suites (P2-6) and the device suite (P2-7) are what prove the screens | TEST_RESULTS 78 to 83 |
| P2-6 | Phase suites on staging: the four phase acceptance points with real sign-ins; the existing suites; a legacy-client suite standing in for build 1.1.7 | **Done on staging**: criteria 1 to 7 met, no product defect | TEST_RESULTS 86 |
| P2-7 | Version 1.2.0, a staging build of the APK, `test:apk` on a device or emulator | **Done on the emulator** (fresh install). Not shown: an upgrade from 1.1.7 with queued work on a real device | TEST_RESULTS 87, 88 |

Criteria for P2-2 to P2-7 are written when each starts.

#### Decisions taken by the Lead for Phase 2 where the proposal left it open (2026-11-23; each can be changed)

- **D2-1 (proposal Decision 9, changed from its recommendation).** Adding a person who already has an account creates an `invited` membership, which gives nothing until that person accepts it themselves after signing in. Reason: a second active membership makes an installed 1.1.7 build's new boreholes fail (it sends no `org_id`, and with two active memberships the database refuses to guess, Phase 1 criterion 8). If an Administrator of any organization could activate a membership for somebody else's account, they could stop another company's crew from working. A brand-new account created by the Administrator is `active` at once, as the proposal says.
- **D2-2.** Member changes are audited now (`audit_log`), not from Phase 4: the table exists and each write is one transaction with its audit row.
- **D2-3.** For the founding organization only, a membership's role and badge are copied back to `profiles`, so installed 1.1.7 builds (which read `profiles.role`) keep showing the right role once the dashboard manages memberships.
- **D2-4.** `admin-users` stays deployed and unchanged until Phase 5; the dashboard stops calling it.
- **D2-5.** Deactivating through `saas-members` never bans the account, in the founding organization too. An account-wide ban remains possible only through `admin-users`.

#### P2-1 acceptance criteria — database support for member management

Two new migrations, later than `20261116010000`, each safe to apply twice, each with a rollback script under `supabase/rollback/`, both covered by `supabase/tests/` (run by `supabase/tests/run.sh`, so by CI). The static migration check, the schema check and the existing database tests stay green and unchanged.

**A. `saas_members` (reusable; names no Drill table, column, role or bucket)**

1. `saas_roles()` returns the role names a membership may carry. The foundation's default is `array['admin','member']`, created only when absent so that an application's replacement survives a re-application. `stable`, `security definer`, `set search_path = public`; executable by `authenticated` and `service_role`, not by `anon`.
2. `saas_member_record_count(org uuid, member uuid) returns bigint`: how many records the member authored in that organization. The foundation's default returns 0, created only when absent. Executable by `service_role` only.
3. Member management functions, executable by `service_role` only (the Edge Function is their one caller; `anon` and `authenticated` cannot execute them). Each takes the acting user's id, does its checks and its write and inserts one `audit_log` row (`actor_id`, `org_id`, `action`, `target` = the member's user id, `details`) in the same transaction, and raises an exception with a distinguishable error code or message for each refusal, changing nothing:
   - `saas_add_member(org, member, role, badge, status, actor)`: inserts a membership with status `active` or `invited`. Refused when the organization does not exist, the role is not in `saas_roles()`, or a membership of that user in that organization already exists (whatever its status).
   - `saas_set_member_role(org, member, role, actor)`: refused for an unknown role, for a member with no membership in `org`, when `member = actor`, and when it would leave the organization without an **active** member holding one of `saas_admin_roles()`.
   - `saas_set_member_badge(org, member, badge, actor)`.
   - `saas_set_member_status(org, member, status, actor)` with `active` or `deactivated`: refused when `member = actor`, when the membership is `invited` (an invitation is accepted or removed, not activated by someone else), and when it would leave the organization without an active administrator.
   - `saas_remove_member(org, member, actor)`: refused when `member = actor` or when it would leave no active administrator. When `saas_member_record_count(org, member)` is 0 the membership row is deleted and the function returns `'removed'`; otherwise the membership becomes `deactivated` and it returns `'deactivated'`. The auth account is never touched.
4. The last-administrator rule holds under concurrency: two requests that each remove, deactivate or demote a different one of an organization's two active administrators cannot both succeed.
5. Invitations, callable by `authenticated` (not `anon`), acting only on the caller's **own** membership: `accept_membership(org uuid)` turns the caller's `invited` membership in `org` into `active`; `decline_membership(org uuid)` deletes it. With no `invited` membership of the caller in `org` each raises `42501` and changes nothing: it cannot activate a `deactivated` membership or touch anyone else's. Each writes an audit row with the caller as actor.
6. None of the functions in 3 trusts the actor argument for authorization (that is the Edge Function's job, P2-2); they only record it and apply the self rules. They do not check that the actor is an administrator.

**B. `drill_members` (Drill)**

7. `saas_roles()` returns the four Drill roles. `saas_member_record_count` counts the member's rows (`created_by`) in the four record tables **of that organization only**, soft-deleted rows included.
8. An account created for an organization other than the founding one never has a founding membership: when the auth account is created with `app_metadata` (a field only the service role can set) naming the organization it is created for, the legacy enrolment of Phase 1 (criterion 27) does not enrol its profile in the founding organization, at no committed moment. An account created without that marker (the legacy path, `admin-users`) is enrolled in the founding organization exactly as before. `user_metadata`, which a user can edit, has no influence on this.
9. Copy-back for the founding organization only (D2-3): a change of role or badge on a **founding** membership is copied to that user's `profiles.role` / `badge_number`; a change on a membership in any other organization never touches `profiles`. The Phase 1 mirror (profile → founding membership) keeps working, and the two do not loop or fight: after any single change on either side, both sides hold the new value, and a badge change never writes a role nor a role change a badge (criterion 26 still holds).
10. A membership's status changed by the functions in 3 clears the ban mark as Phase 1 criterion 40 says; nothing in this migration bans or unbans an account.
11. Privileges stay as Phase 1 criterion 25 states them: no new table privilege for `anon` or `authenticated`; clients still cannot insert, update or delete in `memberships`, `organizations` or `audit_log` directly.
12. Isolation: none of this lets a member of one organization read or change another organization's memberships, and an organization administrator still reads only their own organization's `audit_log` rows.
13. Rollback scripts: `drill_members` first, then `saas_members`; after both, the schema and behaviour are those of Phase 1 (its database tests pass). Tested on a local database only.

**C. Settled after the tests were written (2026-11-24)**

14. The marker of criterion 8 is the key `saas_org` in `app_metadata`. An account that carries the key at all, whatever its value (the founding organization's id, an unknown id, text that is no id), is never enrolled by the legacy path; its memberships come only from `saas_add_member`. A re-application or reconciliation of `drill_tenancy` (Phase 1 criteria 39, 45, 49) does not enrol a marked account either; this is the one change allowed to the Phase 1 migration file.
15. Copy-back (criterion 9) applies to changes made through the member functions, `saas_add_member` into the founding organization included. A direct write to `memberships` is not copied (the existing test `25_mirroring.sql` requires that). `saas_members` still names nothing of Drill's, so Drill attaches its copy-back through a hook the foundation leaves open.
16. Rollback order is members first, then tenancy. The existing Phase 1 rollback tests run unchanged with the member migrations applied, so `drill_members` adds no trigger that survives the tenancy rollback.
17. For a user with no membership in the organization, every function of criterion 3 except `saas_add_member` raises and changes nothing. An `invited` membership cannot be deactivated through `saas_set_member_status`; it can be removed. `saas_set_member_badge` on oneself is allowed. `saas_add_member` takes only `active` or `invited`.
18. The last-administrator rule refuses only a change that takes an organization from one or more active administrators to none. Changes to other members of an organization that already has none are allowed.

19. When an Administrator deactivates or removes, through the member functions, a founding membership that a ban had already deactivated, the ban mark is cleared: lifting the ban later does not bring that member back.
20. Nothing is copied to `profiles` for a membership that is `invited`, whichever change it is (add, role or badge), and nothing is copied when it is accepted: the invited account may belong to another company.
21. Accepted as they are, and to be listed in the production checklist: the member functions rely on the default isolation level (READ COMMITTED), which is what the API uses; the rollback scripts assume the documented order (members before tenancy); re-applying the `drill_tenancy` file on its own after `drill_members` puts the Phase 1 enrolment function back, so `drill_members` must be applied again after it (RF-101).

22. (Replaces the last sentence of criterion 8; RF-102.) The auth server creates an account in two steps inside one transaction: the row is inserted with the request's `user_metadata` and without its `app_metadata`, which is added by an update afterwards. So the enrolment, which runs at the insert, must see the marker there: an account created with `saas_org` in its `user_metadata` **or** its `app_metadata` at the insert is not enrolled in the founding organization. This is safe in the direction that matters: at that moment the key can only withhold a membership, never grant one, and after the insert `user_metadata` has no influence on anything. A reconciliation (criterion 14) still looks at `app_metadata` only, which a user cannot edit. `saas-members` sets the key in both. Proved with the real auth server on staging (P2-2 criterion 9).

**D. After the fourteenth review (2026-11-24)**

23. An `invited` membership of the target gives the inviting organization nothing: `shares_org_as` does not count it, so a profile is readable by another organization's Supervisor or Administrator only once its owner is, or has been, a member (active or deactivated) (RF-103).
24. `drill_members` states the privileges of every function it creates or replaces in the same statement, so they are right whatever was there before (RF-104).
25. (Deferred, RF-105.) The tenancy rollback would give access back to members removed or deactivated through the member functions, because the pre-tenancy rules read only the account ban. A refusal in the rollback script was written and withdrawn: three existing Phase 1 rollback tests run it on fixtures it would refuse, and those tests are not to be changed for this. Instead it is a step of the rollback procedure (see "Needs the owner"): before the tenancy rollback, ban every account that is not banned and has no active founding membership.
26. `accept_membership` and `decline_membership` take the same organization lock as the member functions (RF-107).

#### P2-2 acceptance criteria — Edge Function `saas-members` (drafted 2026-11-23; final when P2-1 is done). Owner's instruction applies: the smallest function and the smallest set of tests that cover each criterion once

`supabase/functions/saas-members/` (`handler.ts`, `index.ts`). Reusable: it names no Drill table, column, role or bucket (`profiles` and the record tables included); a test checks it. `admin-users` is not changed.

1. A request needs a valid session (otherwise 401) and names one organization: `org_id` as a query parameter on GET, as a body field otherwise; missing or not a uuid is 400. The caller needs an **active** membership in that organization with a role in `saas_admin_roles()`; otherwise 403, the same answer whether the organization exists or not. Being a platform administrator gives nothing here. `profiles.role` is not consulted.
2. GET answers `{ members: [...] }`: every membership of that organization, whatever its status, and nobody else. Each: `id`, `email`, `name`, `role`, `badgeNumber`, `status`, `createdAt`, `lastSignInAt`, `records` (from `saas_member_record_count`), `isSelf`. Name and email come from the auth account; for an `invited` membership `name` is empty and `lastSignInAt` is null until the person accepts (RF-110). The list is complete however many accounts the project holds.
3. POST `{ org_id, email, name, role, badgeNumber, password }` adds a person. A role outside `saas_roles()` is 400 before anything is created.
   - No account has that email: `password` is required, under the same rule `admin-users` applies; the account is created confirmed, carrying the `app_metadata` marker of P2-1 criterion 8, and gets an `active` membership. 201 `{ id, outcome: 'created' }`. If the membership cannot be created the new account is deleted again; nothing is left behind.
   - An account has that email and that email was confirmed (RF-111) (compared without regard to case, found reliably however many accounts exist): an `invited` membership and nothing else. That account's password, metadata and ban state are not touched and the request's `password` is ignored. 201 `{ id, outcome: 'invited' }` (D2-1).
   - Already a member of this organization, whatever the status: 409, nothing changed.
4. (A member may change their own badge; the self rule covers role, status and removal.) PATCH `{ org_id, id, action }` with `setRole` (`role`), `setBadge` (`badgeNumber`), `deactivate`, `reactivate`. DELETE `{ org_id, id }` answers `{ action: 'removed' | 'deactivated', records }`. The target must have a membership in **that** organization: any other id, existing or not, a member elsewhere or not, gets 404 "No such member", indistinguishable, and nothing is changed. Acting on oneself is 400; leaving the organization without an active administrator is 409; reactivating an `invited` membership is 409.
5. A target who also belongs to other organizations is managed normally: only the membership in the named organization changes. No request ever bans, unbans, deletes or changes the password of an existing account (D2-5).
6. Every membership write goes through the functions of P2-1 criterion 3, so each has its audit row; the function never writes `memberships` directly.
7. Shape, chosen to keep the code and its tests small (2026-11-24): the whole request logic, authorization included, is `handle(req, ports)` in `handler.ts`, which imports nothing from a URL and uses no Deno global, so the gate's unit tests import it directly. Everything it needs from outside comes through `ports` (who the caller is, memberships, role lists, accounts, the P2-1 functions). `index.ts` only builds the ports with the service-role client and serves `handle`; it has no decisions of its own and is proved on staging (criterion 9). No `policy.ts` and no `_shared/saas` until a second function needs one. The unit tests cover, once each: 401, 400, 403; the list; the three POST outcomes and the clean-up when the membership cannot be created; the 404 for a target outside the organization with nothing written; the mapping of criterion 10; 500 on a failed read with nothing written; ids compared after normalising case.
8. A failed read ends the request with 500 and one fixed message before anything is written; the cause goes to the log only. Unknown methods are 405; CORS as `admin-users`.
10. The refusals of the P2-1 functions are mapped by their code, never by matching message text: `SM002` and `SM008` → 400; `SM003`, `SM006`, `SM007` → 409; `SM004` → 404 "No such member"; `SM005` → 400; anything else → 500 with the fixed message.
9. Deployed to staging after the P2-1 migrations. A suite `e2e/saas/members_e2e.py` proves on staging, with real sign-ins and two organizations: every verb by each Administrator against the other organization is refused and changes nothing; Driller, Data Logger, Supervisor, a deactivated Administrator and an invited Administrator are refused; an account created for the second organization has no founding membership; adding an existing account gives `invited`, which reads nothing until `accept_membership`; deactivating a member of both organizations in one leaves the other working.

#### P2-3 acceptance criteria — client foundation `src/saas` (drafted 2026-11-24)

Reusable: files under `src/saas/` import nothing from the rest of `src/` and name no Drill table, role or bucket. A test in the gate checks both. Everything is unit-tested in the gate with injected dependencies (the Supabase client, `fetch`, storage); no network.

1. `api.ts`: `fetchMyOrganizations()` returns the caller's memberships from `my_organizations()` as `{ orgId, name, role, status }[]`; `acceptMembership(orgId)` and `declineMembership(orgId)` call the functions of P2-1 criterion 5; `listMembers(orgId)`, `addMember(orgId, input)`, `setMemberRole`, `setMemberBadge`, `deactivateMember`, `reactivateMember`, `removeMember` call `saas-members` with the session's token and always send the organization they were given. A non-2xx answer becomes an `Error` carrying the function's message and its status.
2. `orgContext.ts`, pure: given the memberships and the remembered choice it returns the active organization or why there is none. Only an `active` membership can be the active organization. The remembered one is kept while it is still active; with exactly one active membership that one is chosen without asking; with several and nothing valid remembered the answer is "must choose"; with none it says which of `no-membership`, `invited-only`, `deactivated` applies. The choice is remembered per signed-in user, so a second person signing in on the same browser never inherits the first one's organization.
3. Switching: `mayActivate(orgId, memberships)` is true only for an `active` membership of the caller; the client can never make an organization active that `my_organizations()` did not return as `active`.

#### P2-4 acceptance criteria — dashboard (2026-11-24)

Smallest change to `src/admin/` that meets these; it uses `src/saas` and adds no second copy of its logic. Tests: the `.tsx` changes are proved by the build and by the dashboard suites on staging (P2-6), which need `saas-members` deployed, so for this task the suites are written while the backend is deployed, not before the code.

1. After sign-in the dashboard reads `my_organizations()` and settles the active organization with `resolveActiveOrg`, remembering the choice per user. One active membership: no switcher. Several: a switcher in the header; choosing reloads everything shown. Nothing remembered and several active: the user picks first. No active membership: a screen that says why (no organization, deactivated, or an invitation waiting) with Sign out, and no records.
2. An `invited` membership is shown as a notice naming the organization, with Accept and Decline (`accept_membership`, `decline_membership`); after accepting, that organization can be made active.
3. The signed-in person's role is the role of the **active membership**, not `profiles.role`: the Crew button (Administrator) and the correction rights (Supervisor, Administrator) follow it.
4. Lists show the active organization only: boreholes and ongoing pauses are filtered by its `org_id` (pipe records and events come by borehole). A person in two organizations never sees a row of the other one while one is active. The database still enforces isolation; this is about not mixing two of one's own organizations.
5. Photos: a signed URL is asked for the new path `<org_id>/<author>/<file>` and, when that object does not exist, for the legacy path `<author>/<file>`.
6. The Crew view manages memberships of the active organization through `src/saas` (`saas-members`); nothing in the dashboard calls `admin-users` any more and `crewApi.ts` goes. It shows each member's status (active, invited, deactivated); adding a person who already has an account says they were invited and must accept; removing says what happened (removed, or deactivated because they have records) and no longer claims the person cannot sign in; role change, deactivate and reactivate as today. A member can edit nobody's password.
7. Sign-out and sign-in as another person on the same browser never carries the first person's organization over.

#### P2-5 acceptance criteria — field app (2026-11-25)

Smallest change that meets these. A device works for one organization at a time (proposal section 6). Nothing here changes what an installed 1.1.7 build sends or needs.

1. **Active organization.** When signed in and online the app reads `my_organizations()` and settles the active organization with `resolveActiveOrg` (`src/saas`), remembered per user. One active membership: silently. Several and none remembered: the person chooses before the main screen. None: a screen that says why (as the dashboard's), showing any invitation with Accept and Decline, and Sign out. The active organization's id and the role in it are cached on the device (`getCachedOrgId()` in `src/services/auth.ts`, next to the cached user id), so the app works offline exactly as today; nothing on the write path calls the network.
2. **Role.** The person's role in the app is the role of the active membership, not `profiles.role`; name and badge still come from the profile.
3. **Queued work carries its organization.** `OutboxItem` gains `orgId?: string`, stamped at enqueue from the cached active organization and never changed afterwards. The record transport sends a borehole with `org_id` equal to the item's `orgId`; children are sent as today (the database takes their organization from the borehole). An item with no `orgId` (queued before the update) is sent exactly as today, with no `org_id`. Nothing is ever sent under an organization other than the one it was captured in.
4. **Photos.** An item with an `orgId` uploads to `<org_id>/<user_id>/<file>`; one without uploads to the legacy path as today.
5. **Pull.** The pull asks for the caller's own rows **of the active organization** (`org_id` filter added to the existing `created_by` filter), so a device never holds another organization's records, not even the same person's.
6. **Switching.** Offered only with more than one active membership. Refused while unsent work is queued, by the same rule as signing out; it clears the local records exactly as signing out does (`clearForAccountSwitch`), then pulls the new organization's.
7. **Losing access.** When a refresh finds no active membership, the screen of criterion 1 is shown; queued work is not destroyed. Uploads the database refuses are parked as today.
8. Unit tests, in the existing test files, once each: the borehole row carries the item's `org_id`, and none when the item has none; the photo path for both cases; the pull filter; enqueue stamps the cached organization. The screens are proved by the build, the existing offline-sync suite on staging and the device suite (P2-7).

9. (After the sixteenth review.) The app never changes the active organization by itself: when the cached one is no longer an active membership the organization screen is shown, whatever other memberships exist. Local records and parked work are cleared only from sign-out or from a choice the person made, and with parked work only after the existing confirmation (RF-114). No pull runs while no organization is settled; the first settlement on a device that holds anything, for an account with several active memberships, clears it under the same rules (RF-115). Decisions taken: an empty device with a remembered choice activates silently; a sign-in whose organizations cannot be read fails on the sign-in form and is retried there; against a backend without `my_organizations()` (`PGRST202`) the build behaves as before the change.

### Phase 1 — Tenancy in the database (approved to start 2026-11-15; production migration NOT approved)

Requirement: proposal sections 5, 6, 9, 10 and 12. Everything is built and tested on staging. Applying it to production is a separate step that needs the owner's explicit approval of that migration.

Defaults taken where the proposal left a decision open (each can be changed before production): the four roles stay, per organization (Decision 5); the founding organization is created with the name "Founding organization" and renamed by the owner at production time (Decision 8); photo viewing stays as it is today, Administrators only.

| Id | Task | Status | Evidence |
|---|---|---|---|
| P1-1 | Reusable foundation migration `saas_core`: organizations, memberships, platform administrators, audit log, helper functions | Implemented; green locally and in CI; **Done**: passed the thirteenth review; applied to staging | TEST_RESULTS 40 to 61 |
| P1-2 | Drill migration `drill_tenancy`: founding organization, memberships from profiles, `org_id` on the four record tables, compatibility triggers for installed builds, organization-scoped policies for tables and photos | Implemented; green locally and in CI; **Done**: passed the thirteenth review; applied to staging | TEST_RESULTS 40 to 62 |
| P1-3 | Tenant-isolation suite `e2e/saas/tenant_isolation_e2e.py` and a fixture that creates a second organization on staging | **Done**: 1,273 of 1,273 on staging, three runs. Not in CI: it needs two more secrets (the owner's) | TEST_RESULTS 64 |
| P1-4 | Schema check: every table in `public` has RLS and is organization-scoped or allowlisted; run in CI's database job | Done; runs in CI | TEST_RESULTS 44 |
| P1-5 | Compatibility proof: the 21 existing suites, unchanged, pass against the migrated staging database (the current app sends no `org_id`, so it stands in for the installed 1.1.7 build) | **Done**: 21 of 21 on migrated staging | TEST_RESULTS 62 |
| P1-6 | Migration rehearsal on staging data: row counts before and after match; every row carries the founding `org_id`; a written rollback script | Done on staging for the forward migration (counts, digests, founding `org_id`); rollback script written and tested locally (criterion 14); **not run on staging** (needs the owner) | TEST_RESULTS 61 |
| P1-7 | `admin-users` authorises on membership, not on the global `profiles.role`: the caller needs an active Administrator membership in the founding organization, and may list, create, re-role, ban, unban and delete only accounts that are members of it (criterion 27, RF-072) | Implemented; handler-tested (108 tests); **Done**: deployed to staging; crew suites and the refusals with a second organization pass | TEST_RESULTS 49 to 64 |

#### Phase 1 acceptance criteria

**A. `saas_core` (new migration; must not mention any Drill table, role name or column)**

1. Tables, all with RLS enabled and no INSERT, UPDATE or DELETE granted to `anon` or `authenticated`:
   - `organizations (id uuid pk default gen_random_uuid(), name text not null, created_at timestamptz not null default now())`
   - `memberships (org_id uuid not null → organizations, user_id uuid not null → auth.users, role text not null, status text not null default 'active' check in ('invited','active','deactivated'), badge_number text, created_at, primary key (org_id, user_id))`, with an index on `user_id`
   - `platform_admins (user_id uuid pk → auth.users)`
   - `audit_log (id bigint identity pk, at timestamptz default now(), actor_id uuid, org_id uuid, action text not null, target text, details jsonb)`
2. Functions, all `stable`, `security definer`, `set search_path = public`:
   - `is_org_member(org uuid)`: the caller has an **active** membership in `org`
   - `has_org_role(org uuid, variadic roles text[])`: active membership with one of the roles
   - `saas_admin_roles()`: the role names that administer an organization; the foundation's default is `array['admin']` and an application replaces it
   - `is_org_admin(org uuid)`: `has_org_role` with `saas_admin_roles()`
   - `is_platform_admin()`
   - `my_organizations()`: for the caller, one row per membership: `org_id, name, role, status`
3. Read policies: a member reads their own organizations' rows; a member reads their own membership rows, and an organization admin reads every membership of that organization; platform administrators read organizations and memberships; `platform_admins` and `audit_log` are readable by platform administrators only (an organization admin reads the audit rows of their own organization).
4. Applied to an empty database (CI) it succeeds; applied twice it is harmless.

**B. `drill_tenancy` (new migration)**

5. `saas_admin_roles()` returns `array['Administrator']`; `memberships.role` is constrained to Driller, Data Logger, Supervisor, Administrator.
6. Exactly one organization exists after the migration on a database that had none ("Founding organization"), including an empty database. Every existing profile gets a membership there with its role and badge; a banned account's membership is `deactivated`.
7. `boreholes`, `pipe_records`, `drilling_events`, `shift_logs` gain `org_id uuid not null → organizations`, indexed. Every existing row is assigned the founding organization. The migration fails rather than leave a null.
8. Insert rules, enforced by triggers so the client cannot choose wrongly:
   - A child row (`pipe_records`, `drilling_events`, `shift_logs`) always takes `org_id` from its borehole, whatever the client sent.
   - A borehole sent without `org_id` takes it from the author's membership when the author has exactly one active membership; with none or several it is rejected with error code `42501`.
   - `org_id` cannot be changed by an update on any of the four tables (`42501`).
9. Keeping today's behaviour for the current app and installed builds: a profile created or changed (the existing `admin-users` function still writes `profiles.role` and `badge_number`) is mirrored into that user's membership; while exactly one organization exists, a new profile gets a membership in it. A ban or unban is mirrored into the membership status.
10. Policies. Records: SELECT needs an active membership in the row's organization and (author, or Supervisor/Administrator of that organization). INSERT needs `created_by = auth.uid()` and the role Driller, Data Logger or Supervisor in that organization. UPDATE keeps today's rules (author who is not an Administrator; or a Supervisor/Administrator correcting a pipe record under the existing column guard), each scoped to the row's organization. No DELETE. Profiles: own row, or a profile of someone who shares an organization in which the caller is Supervisor or Administrator. `profiles.role` stays not self-editable.
11. Photos. New path `<org_id>/<user_id>/<file>`: upload needs an active membership in that organization and the caller's own user id as the second segment; read needs the author, or an Administrator of that organization. Legacy path `<user_id>/<file>` keeps working for installed builds: upload to one's own folder; read by the owner, or by an Administrator who shares an organization with the owner. A path whose first segment is neither is denied, without an error.
12. Nothing that a member of one organization does can read, create, change or soft-delete a row, a membership, a profile or a photo of another organization: by listing, by direct id, by sending the other organization's `org_id`, by attaching a child to the other organization's borehole, or by path.
13. The 21 existing suites pass unchanged against the migrated staging database.
14. A rollback script restores the previous policies and drops what the migration added, and is tested on a local or scratch database, not on staging data that matters.

**C. Tests**

15. `e2e/saas/tenant_isolation_e2e.py` proves criterion 12 with real sign-ins against staging: two organizations with a Driller, Supervisor and Administrator each, one user who belongs to both, one deactivated member. For every one of the four tables and every verb; plus profiles, memberships, organizations and photos. It also proves the positive cases (each role still does what it could). It takes its target from `e2e/_target.py`.
16. A schema check fails if any table in `public` lacks RLS, or has neither an `org_id` column nor an entry on a short allowlist (`profiles`, `organizations`, `memberships`, `platform_admins`, `audit_log`). It runs in CI against the database built from migrations.
17. The static migration check, the catalog RLS check and the migration count check in CI stay green.

**D. Decisions taken by the Lead where the criteria were silent (2026-11-16; each can be changed before production)**

18. A deactivated member reads nothing through the policies: no records, no photos (their own included), no organization or membership rows. `my_organizations()` still returns their row with its status, so an app can say why.
19. A Supervisor or Administrator reads the profile of a deactivated member of their organization, so names on old records still resolve.
20. Any active member, Administrators included, may upload under `<org_id>/<own user id>/`. An Administrator of an organization reads every path under `<org_id>/`.
21. The backfill does not change `modified_at` on any row; otherwise every device would download everything again.
22. `TRUNCATE` is revoked from `anon` and `authenticated` on every table in `public`.
23. `memberships.user_id` is `on delete cascade`, so an account with no records can still be deleted as today.
24. An expired ban counts as active. A forged `org_id` on a borehole is rejected (`42501`), not replaced. The child-row and immutability triggers apply to the service role too. Re-sending the same `org_id` in an update is not a change. Migration and rollback files contain no transaction statements. Mirroring from a profile is defined only for users with at most one membership.

25. Privileges are explicit after the tenancy migrations, and the same whether the database started with a hosted project's default grants or with none (TEST_RESULTS 42): `service_role` holds everything on every table in `public`; `authenticated` holds SELECT, INSERT and UPDATE on the four record tables, SELECT and UPDATE of `name` and `badge_number` on `profiles`, and SELECT on the four foundation tables; `anon` holds nothing. This removes privileges the API roles hold today only by default and never needed (for example REFERENCES and TRIGGER, and everything for `anon`); row level security already denied their use.

26. The profile mirror copies only the column that changed: a badge edit never writes a membership role, and a role change never writes a badge (RF-071).

27. Everything mirrored from the legacy tables targets the founding organization only: a new profile is enrolled there (also when other organizations exist), and profile role, badge, ban and unban reach the founding membership and no other (RF-072, RF-076). `admin-users` is to require an active Administrator membership and a target in the caller's organization.

28. Unban reactivates only a membership that a ban deactivated. One deactivated directly stays deactivated (RF-072).

29. The Drill migration leaves no point at which an installed build's insert without `org_id` fails, even if the file is not applied as one transaction (RF-073).

30. Legacy photos (`<user_id>/<file>`) belong to the founding organization only, as the proposal (5.3) says; this replaces the wider reading in criterion 11. Uploading to the legacy path needs an active membership (RF-074, RF-077).

31. Re-applying the Drill migration does not re-enrol a removed member. The rollback refuses to run when more than one organization holds records. `anon` may execute none of the helper functions. Accepted without change: a member can learn whether a user id is in their own organization; a ban that expires is not mirrored; `23503` versus `42501` reveals whether a borehole id exists (RF-077).

**E. Decisions after the tenth review and the validation (2026-11-17; numbers 32 to 38 are P1-7's, below)**

39. The membership in the founding organization always follows the legacy tables once the Drill migration is through, whatever happened while it ran or while it was rolled back. The mirror triggers are created before the enrolment, so an account created, re-roled or banned at any point of the migration is not missed. Whenever the migration marks the founding organization (a first application, or a re-application after the Drill rollback alone), every existing founding membership is brought into line with its profile (role, badge) and with the account's ban. A member removed while the migration was in force is still not re-enrolled by a plain re-application (criterion 31) (RF-079, RF-082).
40. Any direct change of a membership's status clears the mark that a ban deactivated it; an unban then leaves it as it is (RF-086).
41. The Drill rollback also refuses when an organization other than the founding one has a membership (RF-081).
42. `saas_core` leaves no point, applied one statement at a time on a database with a hosted project's default grants, at which `anon` or `authenticated` can insert, update or delete in a foundation table (RF-083).
43. The legacy photo path needs an **active membership in the founding organization**: to upload, and to read one's own. This tightens criterion 30 (RF-087).
44. Confirmed as specified: a ban leaves an `invited` membership alone; the founding Administrator reads no legacy photo whose owner is not a founding member. The message for an undecidable founding organization says how to add and set the flag by hand (RF-084).

45. A founding organization that has no membership at all is a first application, however its flag came to be set: the migration enrols every profile then. So the procedure the error message gives (add the flag column by hand, set it on one organization, apply again) ends with every legacy account enrolled.
46. After the Drill rollback alone the legacy model is in force again, where a ban is the only deactivation. A re-application therefore sets each founding membership's status from the ban alone: banned is deactivated (marked as by the ban), not banned is active; an `invited` membership is left as it is. Criterion 42 is judged by behaviour: a refusal by row level security counts.

**F. Decisions after the eleventh review (2026-11-17)**

47. The Drill rollback is safe applied one statement at a time, like the migration: after every statement no signed-in user can change their own `profiles.role`, and an installed build's inserts, upserts, reads and photo uploads behave as they did before the statement or as they will after the rollback, never worse (RF-088).
48. The Drill rollback refuses, and changes nothing, when any row of the four record tables belongs to an organization other than the founding one, or any stored photo sits under the folder of another organization, whether or not that organization still has members (RF-091).
49. A first application or a reconciliation enrols only profiles that have **no membership in any organization**; an account that belongs to another organization is never added to the founding one by the migration. (New accounts created through the legacy path are still enrolled in the founding organization, criterion 27.) Replaces the wider reading of criteria 39 and 45 (RF-093).
50. `admin-users` lists every member of the founding organization however many accounts the project holds, and the record count it shows for a member counts records of the founding organization only. The decision between deleting and deactivating still looks at the account's records everywhere. An id is compared after normalising its case, so the rules against changing or removing oneself hold for any spelling of one's own id (RF-089). Every failed lookup (the founding organization, memberships, the account listing, profiles, record counts, also on delete) answers 500 with a fixed message, not the database's, and nothing is written (RF-094, RF-095).
51. A ban or unban whose transaction is open while any statement of the migration runs is not missed, also when the file is applied statement by statement (RF-090). Accepted and recorded, not changed: RF-096.

**G. Decisions after the twelfth review (2026-11-17)**

52. Criterion 51 also holds for a ban or unban that **starts** while a statement of the migration is running, not only for one already open before it (RF-097).
53. The Drill rollback also refuses when a stored photo has the shape of the new path (`<uuid>/<uuid>/…`) and its first segment is not the founding organization's id, whether or not an organization with that id still exists. A legacy path (`<user id>/<file>`) never stops it (RF-098).

#### P1-7 acceptance criteria — `admin-users` authorises on membership (criterion 27, RF-072)

`admin-users` stays the legacy crew function of the founding organization until `saas-members` replaces it in Phase 2. Its request and response shapes do not change, so the current dashboard and the existing crew suites work unchanged.

32. The caller needs a valid session (otherwise 401) and an **active** membership with the role Administrator in the founding organization (otherwise 403). `profiles.role` is not consulted. With no founding organization the answer is 403.
33. The list (GET) holds only accounts that have a membership in the founding organization, whatever its status; role and badge come from that membership.
34. Changing a role, deactivating, deleting and reactivating need a target that has a membership in the founding organization. Any other id, existing or not, gets 404 "No such account" and nothing is changed; the two cases are indistinguishable.
35. A target that also has a membership in another organization is refused with 409 and nothing is changed: a ban or a deletion acts on the whole account, and this function may not reach into another organization. (Managing such accounts belongs to `saas-members`.)
36. Creating an account is unchanged; the new account ends with an active founding membership carrying the requested role and badge. The rules against changing or removing oneself stay.
37. The decisions in 32, 34 and 35 are made by pure functions in `supabase/functions/admin-users/policy.ts` (no imports, no Deno or network use), so they are unit-tested in the gate: `callerMayAdminister(foundingOrgId, callerMemberships)` returns a boolean; `targetDecision(foundingOrgId, targetMemberships)` returns `'ok'`, `'not-found'` or `'other-organization'`; a membership is `{ orgId, role, status }`. `index.ts` uses them and nothing else to decide. The function as deployed is proved on staging with real sign-ins and a second organization, in the tenant-isolation suite (P1-3).
38. The function needs the tenancy migrations: it is deployed after them, never before. On production both are the owner's step.

### Phase 0 — Preparation (approved 2026-11-15)

Acceptance criteria from the proposal: the existing unit and e2e suites pass against staging; production holds no test accounts. Added by the owner: all integration and RLS tests run against staging, never production; no production data is modified.

| Id | Task | Status | Evidence |
|---|---|---|---|
| P0-1 | Commit the owner's pending working-tree changes (unsupported-browser gate, version bump) as their own commit, unchanged | Done | Commit `58dba82`; quick gate green after it. `.agents/`, `.claude/skills/` and `skills-lock.json` are the owner's tool installs and were left untracked. |
| P0-6 | Guard and scope follow-ups from the reviews: RF-038, RF-041 to RF-046, RF-048 | Implemented; follow-ups in P0-9 | TEST_RESULTS 18, 20. Fourth review found RF-052 to RF-056 in the new staging allowances. |
| P0-2 | Create the staging Supabase project at no cost (separate free organization), apply the six migrations, deploy `admin-users`, create the test accounts there, set `STAGING_REF` | Done | Free organization `wbxjlzwsbkvatrwgjcze` (plan confirmed `free`); project `drill-staging`, ref `miskkzttkoqlmncqlzrl`, us-west-2. Six migrations applied with `supabase db push --db-url`. Auth settings set to match production (signup disabled, auto-confirm on). `admin-users` deployed. Database password is in the macOS keychain (`drill-staging-db`); target settings are in the git-ignored `.env.e2e`. Test accounts created on staging: driller1, driller2, admin1, supervisor1 (`@example.com`), with the roles and names the suites expect. |
| P0-3 | e2e suites and management scripts take their target from the environment, contain no hard-coded project URL or key, and refuse to run against the production ref | Implemented; follow-ups in P0-9 | All 21 suites pass on staging (TEST_RESULTS 23). Fourth review: the refusals held in every form tried; no assertion weakened. |
| P0-4 | Unlink the working copy from production; stop tracking `supabase/.temp/` | Done (uncommitted) | `supabase/.temp/` removed from git and ignored; the working copy is linked to staging; `STAGING_REF` set in `guard.conf`. |
| P0-5 | Read-only checks on production: the live schema matches the migrations; backups exist; no test accounts remain | Done | TEST_RESULTS 24: no difference in 19 catalog areas between production and a database built from the migrations; no `@example.com` accounts in production; daily backups present. One open question for the owner: the `probe` function (RF-049). |
| P0-9 | Fix the fourth review's findings (RF-052 to RF-057) | Done; remainder in P0-10 | TEST_RESULTS 25, 27. Commit `48cdc35`. |
| P0-10 | Fix the fifth review's findings (RF-059, RF-061) | Done; remainder in P0-11 | TEST_RESULTS 29, 31 |
| P0-11 | Fix the sixth review's findings (RF-063 to RF-065) | Done; remainder in P0-12 | TEST_RESULTS 32, 33 |
| P0-12 | Fix the seventh review's findings (RF-066 to RF-068) | Done; verified by the eighth review | TEST_RESULTS 34 to 36 |
| P0-14 | Pin the staging e2e job to a versioned runner image | Done | TEST_RESULTS 38, 39 |
| P0-13 | Eighth review: `gh pr close` leaves the known-safe list (RF-069); rebuild the commits before pushing (RF-070) | Done | TEST_RESULTS 37 |
| P0-7 | Real JSX type checking: `@types/react` and `@types/react-dom`, plus a test that a wrong prop fails | Done | TEST_RESULTS 26, 29 |
| P0-8 | Run the RLS, Data Logger and offline-sync suites against staging from CI | Done; green in CI | TEST_RESULTS 29 |

#### P0-3 acceptance criteria — tests and scripts target staging and refuse production

1. One module, `e2e/_target.py`, is the only place a suite learns where to connect. It reads `DRILL_E2E_SUPABASE_URL`, `DRILL_E2E_PUBLISHABLE_KEY` and `DRILL_E2E_PASSWORD` from the environment, falling back to a git-ignored `.env.e2e` file at the repository root with the same names. It exposes the URL, key, project ref, test password and the test account emails.
2. It **refuses**, with exit code 2 and a one-line message, when any value is missing, when the URL's project ref equals `PROD_REF` in `scripts/hooks/guard.conf`, or when `PROD_REF` cannot be read. There is no flag or variable that overrides the refusal.
3. No file under `e2e/` contains a Supabase project URL, project ref, publishable key or password literal. Every suite gets them from `_target`.
4. Suites that drive the web app do not rely on whatever server happens to be running. The harness starts its own Vite server on a dedicated port with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set from `_target`, so the app under test talks to the same project as the suite, and stops the server afterwards. The repository's `.env.local` (production) is never what the tested app uses.
5. Device suites (`apk*.py`) install a build made for the tested project; until such a build exists they refuse with a clear message. They are not run in Phase 0.
6. A self-test, `e2e/target_selftest.py`, needs no network: it checks the refusals in criterion 2 and that criterion 3 holds for every file under `e2e/`. The gate runs it.
7. The management scripts (`scripts/create-user.sh`, `delete-test-data.sh`, `check-attribution.sh`) have no default project. They require `SUPABASE_PROJECT_REF`. If it equals `PROD_REF` they stop unless called with `--production` as the first argument. `delete-test-data.sh` deletes only accounts whose email ends in `@example.com`, on any project.
8. `package.json` scripts keep their names. README's test section says how to point the suites at staging.

#### P0-6 acceptance criteria — guard and scope follow-ups

- **RF-038:** a change under `docs/saas/` is a violation for every role unless the Lead passes `--allow 'docs/saas/*'`.
- **RF-041:** the Stop-gate cache key includes the path of every untracked file.
- **RF-042:** the gate is red when a file named like a test (`*.test.*`, `*.spec.*`, or under `__tests__/`), tracked or untracked and not ignored, would be run by none of the gate's test commands. Python files under `e2e/` are exempt: they are run by their own commands.
- **RF-043:** with staging configured: a non-local `supabase db reset` asks; a request to the management API for the staging project is allowed except `DELETE` on the project itself, which asks; `supabase/.temp/**` is a protected path.
- **RF-044:** a missing `tsx` makes the gate red; there is no fallback to `npm test`. The gate's own tests use an explicit switch instead.
- **RF-045:** `python -m unittest` (and `-m pytest`) with any argument whose first dotted part is `e2e` is treated as an e2e run.
- **RF-046:** under `.claude/` and `.github/` a `__tests__/` folder is not a test path; `.git/info/exclude` and `.gitattributes` changes are violations; the Stop-gate key file is in the snapshot.
- **RF-048:** rule 9 changes. Once `STAGING_REF` is set, running a Python file under `e2e/` or a `test:*` package script is allowed, because the suites refuse production themselves (P0-3). While `STAGING_REF` is empty they still ask. A management script asks when `--production` appears in the call or `SUPABASE_PROJECT_REF` is not a literal equal to the staging ref on the same line; otherwise it is allowed.
- The gate runs `python3 e2e/target_selftest.py` as a gate named "e2e targets staging only" (P0-3 criterion 6); the guard allows that one file even while `STAGING_REF` is empty.

#### P0-12 acceptance criteria — seventh review fixes

- **RF-066, guard:** every `gh` invocation counts as tree-changing unless its subcommand is on a short list of ones that cannot change the working tree (`gh pr view|list|checks|create|status|diff|comment|edit|ready|review|reopen` (`close` was removed in P0-13: with `--delete-branch` it can switch branches), `gh issue` except `develop`, `gh run`, `gh workflow`, `gh api`, `gh auth`, `gh secret`, `gh variable`, `gh search`, `gh status`, `gh browse`, `gh label`, `gh release`, `gh cache`, `gh repo view|list`). Aliases and extensions therefore count. Alone they are allowed.
- **RF-066, management scripts:** after any tree-changing command on the same line, `create-user.sh`, `delete-test-data.sh` and `check-attribution.sh` ask even with the staging prefix.
- **RF-068, guard:** `git read-tree`, `git checkout-index` and `git sparse-checkout` count as tree-changing; a word with `supabase/` followed by a brace or glob character counts as naming the link directory. A directory option (`tar -C`, `env -C`) and a path assembled in inline code are listed as known limits.
- **RF-068, gate:** the production-link gate trims every kind of whitespace and a leading byte-order mark before comparing.

#### P0-11 acceptance criteria — sixth review fixes

- **RF-063, guard:** `gh pr checkout`, `gh repo clone`, `gh repo sync`, `gh repo fork --clone` and `hub` with a tree-changing subcommand count as tree-changing, exactly like their git equivalents: a Supabase call that rests on the staging link, an e2e run and a `test:*` script later on the same line ask. Alone they are allowed. `gh pr view`, `gh pr checks`, `gh pr create`, `gh run watch` do not count.
- **RF-064, Stop hook:** the "unchanged since the last green run" key includes the content of `supabase/.temp/project-ref` (or the fact that it is absent). Changing only that file re-runs the gate.
- **RF-065, gate:** the production-link gate compares each non-empty line of the link file, trimmed, case-insensitively: if any line equals `PROD_REF` the gate is red.
- **RF-065, guard:** when any word on the line names a path under `supabase/.temp` (a write, copy, move, link, redirect target or `git show … >` into it), a Supabase call that rests on the link later on the same line asks.
- **RF-065, CI:** the staging e2e job is preceded by a small job that reports whether the secrets are available; the e2e job has a job-level `if` on that output, so without secrets GitHub shows it as skipped, not as passed. The message that the suites were not run stays.
- **Self-test:** `e2e/target_selftest.py` holds no literal that it forbids; it compares SHA-256 digests.

#### P0-10 acceptance criteria — fifth review fixes

- **RF-059, guard:** when a git command that can change the working tree or create a checkout (`checkout`, `switch`, `pull`, `merge`, `rebase`, `reset`, `stash`, `restore`, `revert`, `cherry-pick`, `am`, `apply`, `bisect`, `worktree add`, `clone`, `submodule`) appears earlier on the same line, the link and the tree are unknown: a Supabase CLI call that would otherwise count as linked to staging, an e2e run and a `test:*` script all ask. `git checkout -b <new>` and `git switch -c <new>` do not change the tree and do not count. The same git commands on their own line stay allowed.
- **RF-059, gate:** a gate named "working copy is not linked to production" fails when `supabase/.temp/project-ref` exists and equals `PROD_REF` from `scripts/hooks/guard.conf`; it passes when the file is absent or holds any other ref; it fails if `guard.conf` cannot be read.
- **RF-061:** `builtin cd`, `command cd` and `chdir` change the effective directory like `cd`; `npx`/`bunx` `--prefix`/`--cwd`, `sudo -D` and `find -execdir` make it unknown; a `cd` to a directory that does not exist when the hook runs makes it unknown; a hook `cwd` that is missing, empty or not absolute is unknown (existing tests that send no `cwd` are updated to send the project root); Python given a relative script while the directory is unknown asks; a dotted module name with an `e2e` part anywhere asks under the e2e rule; `npm_config_*` in front of a `test:*` run asks; `supabase link` and `unlink` always ask. A literal `cd "$CLAUDE_PROJECT_DIR"` counts as the project root.

#### P0-7 acceptance criteria — JSX is really type-checked

- `@types/react` and `@types/react-dom` (major version matching the installed React) are dev dependencies, with the lockfile updated; `npm run lint` passes with zero errors.
- A script test proves the check is real: a fixture component used with a wrong prop makes the same `tsc` configuration fail with a type error, and the fixture with the right prop passes. If the React types go missing again, that test fails.

#### P0-8 acceptance criteria — suites run against staging in CI

- A CI job runs `e2e/rls_e2e.py`, `e2e/data_logger_e2e.py` and `e2e/offline_sync_e2e.py` against staging, taking `DRILL_E2E_SUPABASE_URL`, `DRILL_E2E_PUBLISHABLE_KEY` and `DRILL_E2E_PASSWORD` from repository secrets. It installs what the browser suite needs (Python Playwright and Chromium).
- When the secrets are not available (a pull request from a fork), the job is skipped with a message that says so; it never reports success for tests it did not run. Pushes to this repository's branches have the secrets, so the job runs for them.
- The job has no production credentials and the suites' own refusal still applies.
- Actions stay pinned to commit SHAs.

#### P0-9 acceptance criteria — fourth review fixes

- **RF-052:** a Supabase CLI call is "linked to staging" only when the command's effective directory is the project root, or a directory below it with no `supabase/` folder of its own between it and the root. Anywhere else (a worktree, a nested checkout, a directory outside the project) it asks.
- **RF-053:** with a staging ref set, an e2e run is allowed only when the file resolves to `<project root>/e2e/…` and the effective directory is inside this project and not inside a nested checkout (a directory with its own `.git`); a `test:*` package script only when the effective directory is the project root. Python reading its program from stdin, or given a dynamic script argument, asks again.
- **RF-054:** on staging these ask: `supabase migration down`, a non-local `db reset`, deleting or pausing the staging project by any route the guard recognises. Deleting staging test data (`delete-test-data.sh`, REST deletes, SQL) is allowed. WORKFLOW.md says so and says that SQL sent to staging is not inspected.
- **RF-055:** when `GATE_UNIT_TEST_CMD` is used the final line reads `GATE GREEN (quick; unit tests REPLACED by GATE_UNIT_TEST_CMD - not a real run)` (or the `full` equivalent), never the plain green line; the guard asks when the variable appears on a command line.
- **RF-056:** only `--help` / `-h` excuse a destructive Supabase call; a management-API path with a `.` or `..` segment is treated as the project itself; `curl -K` / `--config` to a Supabase host asks; a later `+n` or `+o noexec` cancels `bash -n`; a dynamic word between `env` and a management script asks.
- **RF-057:** README names `DRILL_E2E_APK_TARGET_REF` and shows `--production` in the examples meant for the live project.
- **Management scripts have tests:** `scripts/management-scripts.test.mjs` exercises the three scripts in dry mode (`DRILL_SCRIPT_DRY_RUN=1`, a fake `guard.conf`, stub `curl` and `security` that fail the test if called): no ref, the production ref with and without `--production`, `--production` not first, unreadable `guard.conf`, non-`@example.com` addresses to the delete script, and quote, backslash and control characters to the create script.

#### DEMO-1 acceptance criteria

A script, `scripts/check-migrations.mjs`, with no dependencies beyond Node:

1. Exports `findTablesWithoutRls(files)`, where `files` is an array of `{ name, sql }`. Returns the sorted, de-duplicated list of `public` tables that are created in any file but never have row level security enabled in any file.
2. Recognises `create table`, with or without `if not exists`, with or without the `public.` prefix, in any letter case, with or without double quotes around names. Tables in other schemas (for example `storage.`, `auth.`) are ignored.
3. Recognises `alter table [if exists] [only] [public.]<name> enable row level security`, in any letter case and across line breaks.
4. Recognises the dynamic pattern this repository uses: an `execute format('alter table public.%I enable row level security', t)` inside a `foreach t in array array['a', 'b']` loop counts for every table in the array.
5. Text inside SQL comments (`-- …` and `/* … */`) is ignored, so a commented-out `enable row level security` does not count and a commented-out `create table` is not reported.
6. A table that is created and later dropped (`drop table`) is not reported.
7. Run as a command (`node scripts/check-migrations.mjs [dir]`, default `supabase/migrations`), it prints one line per offending table and exits 1; with none it prints a confirmation and exits 0. A missing or empty directory exits 2 with a message, so a wrong path can never look like a pass.
8. Against the six migrations in this repository it reports nothing and exits 0.

#### WF-4 acceptance criteria

Harden the enforcement after the security review (RF-010 to RF-024).

**Guard hook** (`scripts/hooks/guard-bash.sh`; may delegate to Python 3 or Node, standard library only). Reads the hook JSON on stdin. Configuration comes from `scripts/hooks/guard.conf` (`PROD_REF=…`, `STAGING_REF=…`, the latter empty until a staging project exists) and the link state from `supabase/.temp/project-ref`, both resolved under `$CLAUDE_PROJECT_DIR` (falling back to the repository the script lives in), so tests can point it at a temporary directory. It analyses each simple command of the line (split on `;`, `&&`, `||`, `|`, newlines and subshells) by its argument words after shell-style unquoting, and looks inside `bash -c`, `sh -c`, `zsh -c` and `eval` strings. First matching rule wins:

1. **Fail closed.** Interpreter or `jq` missing, stdin not JSON, or no non-empty string command: exit 2 with a message on stderr.
2. **Deny** `git push` (including `git -C dir push`) when any destination is `main` or `master` in any refspec form (`main`, `src:main`, `refs/heads/main`, `:main`, `+…`), or with `--all` or `--mirror`, or forced (`--force`, `--force-with-lease`, any short-flag group containing `f`, or a `+` refspec).
3. **Deny** merging a pull request or changing branch protection: the GitHub CLI's pull-request merge subcommand with flags anywhere, `gh api` on a path ending `/merge` or containing `/protection` with a mutating method, or a GraphQL `mergePullRequest`.
4. Words inside the arguments of a non-executing command are not commands: a commit message or a `grep` pattern that mentions a push to main or a merge is allowed.
5. **Ask** when the production ref appears anywhere in the line, quoted or not.
6. **Ask** for any `supabase` CLI call except: `--version` and `--help`; a call carrying `--local` as a real argument; `start`, `stop`, `status`, `init`, `migration new`, `projects list`, `orgs list`; and a call that is provably aimed at staging, meaning `STAGING_REF` is set and either the call names it (`--project-ref <staging>`) or the link file contains exactly the staging ref. A `--local` inside a comment does not count. `projects create` and `orgs create` always ask.
7. **Ask** for `psql`, `pg_dump`, `pg_restore` unless the connection target is a literal `localhost` or `127.0.0.1`, or a literal containing the staging ref. A target held in a variable asks.
8. **Ask** for `curl` or `wget` to a `supabase.co` or `api.supabase.com` host, or to a URL built from a variable whose name contains `SUPABASE`, unless the literal URL contains the staging ref.
9. **Ask** for the management scripts by basename (`create-user.sh`, `delete-test-data.sh`, `check-attribution.sh`), however they are reached; for any Python file under `e2e/` (including after `cd e2e`, or `python -m e2e.…`); and for any `test:*` package script with any runner (`npm run`, `npm run-script`, `yarn`, `pnpm`, `bun run`). Plain `npm test` is allowed. There is no environment-variable escape hatch.
10. Otherwise allow: exit 0 with no output.

**Scope check** (`scripts/check-scope.sh`): the snapshot also records `HEAD` and a hash of `node_modules/.package-lock.json`. For every role, a changed `HEAD` or a change under a protected path is a violation unless the Lead passes `--allow <glob>` (repeatable). Protected: `.claude/**`, `.github/**`, `scripts/hooks/**`, `scripts/gate.sh`, `scripts/check-*.sh`, `scripts/check-*.mjs` (not their tests), `package.json`, `package-lock.json`, `CLAUDE.md`, `.gitignore`, `node_modules/.package-lock.json`. Test paths also include `*.test.js`, `*.test.cjs`, `*.spec.*` and `__tests__/`. Changes under `docs/saas/` are listed as a note for the Lead to confirm, not as a violation. `CHECK_SCOPE_ROOT` may point the script at another repository, for tests.

**Secret scan** (`scripts/check-secrets.sh`): additionally catches, case-insensitively, a service-role key assigned in any common form; a bare JWT of three base64url segments at least 100 characters long; a Postgres URL with an inline password; `sbp_…` tokens; GitHub tokens (`ghp_`, `gho_`, `ghs_`, `github_pat_`); Gradle `storePassword` and `keyPassword` in `=`, quoted and space-separated forms. Prints file and line number only, never the matched text. A failure of the scan itself exits non-zero. Still allows `sb_publishable_…`. `CHECK_SECRETS_ROOT` may point it at another repository, for tests. Test fixtures build secret-shaped strings at run time so the test file itself is clean.

**Gate** (`scripts/gate.sh`): script tests run `scripts/**/*.test.mjs`; a run that finds zero script tests fails.

**Stop hook**: applies on every branch except `main` and `master`, including a detached `HEAD`.

**Session-start hook**: injects at most 40 lines, labelled as a record of state rather than instructions.

**CI**: actions pinned to commit SHAs and the Supabase CLI to a version; the database job fails if the number of applied migrations differs from the number of migration files, and fails if any table in `public` has row level security disabled (catalog query).

## Decisions

| Date | Decision | By |
|---|---|---|
| 2026-11-26 | **Phase 4 leftovers, then Phase 5** ("go ahead and do whatever you have left for 4 and proceed to 5"), after the Lead recommended doing only the first half of Phase 5 now. Recorded as: RF-161 and the audit list's emails on the Phase 4 branch; Phase 5 change password and password reset on staging; email invitations when the owner names a sender; the cleanup only after every crew phone runs the new build (it stops 1.1.7). | Owner |
| 2026-11-25 | **No push to `main` after Phase 3** ("i will take your recommendation"): Phase 3 gets its own branch and pull request, Phase 4 continues from it, and `main` is updated together with the production migration, in the order database, functions, dashboard. | Owner |
| 2026-11-25 | **Phase 4 approved, to start when Phase 3 is done** ("once you are done with phase 3, you can push it to main and continue on phase 4"). The Lead goes from task to task without asking. The push to `main` is not done by the Lead until the owner has answered the risk raised the same day: `main` would receive pull requests 3 to 6 unmerged-so-far in one step, and if Netlify builds from `main` the new dashboard would go live against a production database that has none of the migrations. | Owner |
| 2026-11-25 | **Phase 3 approved, after the Phase 2 gaps** (answer "Both, gaps first" to the Lead's question). Staging only; production still needs the owner's approval of each specific action. The upgrade test on a real phone is done last. | Owner |
| 2026-11-24 | **Keep test code minimal and do not bloat the code base.** From here each brief asks for the smallest set of tests that covers every criterion once, and the smallest implementation that meets it. Existing tests are not removed or weakened. | Owner |
| 2026-11-23 | **Phase 2 approved** ("proceed with phase 2"). Staging only; production migrations, deployments and data changes still need the owner's approval of that specific action. | Owner |
| 2026-11-15 | Workflow tooling goes on its own branch and pull request, separate from the SaaS phases. | Lead |
| 2026-11-15 | The existing e2e suites are treated as production-targeting and are gated behind owner approval until Phase 0 repoints them. | Lead |
| 2026-11-15 | Dependency audit runs in CI as informational, not blocking, until the owner decides how to handle existing advisories. | Lead |
| 2026-11-15 | Security review accepted: the guard hook is a tripwire; the real controls are capability removal, server-side branch protection and a catalog RLS check. RF-007 deferred, RF-009 rejected (reasons in REVIEW_FINDINGS). | Lead |
| 2026-11-15 | Detail of Critical and High findings about the **live product** stays out of the public repository until verified fixed; it is kept in the git-ignored `docs/saas/private/`. Findings about this tooling are published. | Lead |
| 2026-11-15 | The Supabase organization is on the Pro plan, where an extra project is billed. Staging will be created in a separate free organization so it costs nothing. | Lead |
| 2026-11-15 | Staging created as project `drill-staging` in a new free organization, so it adds no cost. Free projects pause after about a week idle; a paused staging project only delays tests and is restored from the dashboard. | Lead |
| 2026-11-15 | RF-050: detail withheld; one owner action is pending and has been deferred. The finding stays open and does not block other work. | Owner, Lead |
| 2026-11-15 | **Phase 1 may begin once Phase 0 is complete**, and the Lead may commit as it sees fit. Production migrations and production data changes still need the owner's explicit approval of that specific action. | Owner |
| 2026-11-15 | **Phase 0 approved.** Finish workflow setup (DEMO-1, validation, review, pull request), then run Phase 0 autonomously. | Owner |
| 2026-11-15 | **Staging project approved**: a separate free-tier Supabase project, only if it costs nothing. All integration and RLS tests run against staging, never production. | Owner |
| 2026-11-15 | **Phase 1 not approved.** No production data changes or production migrations. Stop after Phase 0 passes its acceptance criteria and summarise for review. | Owner |

## Blockers

| Id | Blocker | Attempts | Status |
|---|---|---|---|
| — | None | — | — |

## Needs the owner

- **Phase 1, before production** (nothing below has been done; each is the owner's decision):
  - Approve, or not, applying the two migrations to production and deploying `admin-users` after them. Order: `saas_core`, `drill_tenancy`, then the function. Apply in a quiet window, each file as one transaction; on `deadlock detected`, apply again. Create, ban or re-role no account while it runs. Afterwards run the consistency queries in the description of pull request 5; they must return nothing.
  - First check on production: accounts with no profile and accounts banned today (they end with no active membership); objects in `drilling-photos` shaped `<uuid>/<uuid>/…` (any would make a rollback refuse); that public signup is disabled (every new account becomes an active Driller of the founding organization).
  - **Before any tenancy rollback once Phase 2 is applied (RF-105):** ban every account that is not banned and has no active membership in the founding organization (`select u.id, u.email from auth.users u where not coalesce(u.banned_until > now(), false) and not exists (select 1 from memberships m where m.org_id = founding_org_id() and m.user_id = u.id and m.status = 'active')`); otherwise people removed or deactivated in the dashboard get their access back. Roll back in the order `drill_members`, `saas_members`, `drill_tenancy`, `saas_core`, with `saas-members` undeployed first (RF-109). After any re-application of `drill_tenancy`, apply `drill_members` again (RF-101). Only `saas-members` may create accounts for another organization (RF-106).
  - Rollback: both scripts together; it needs the migration history repaired by hand and the previous `admin-users` redeployed. It has been proved on local databases only. Running it once on staging needs the owner's go-ahead.
  - **Before a second organization exists on production (RF-111):** email changes must require confirmation (needs a mail sender, Phase 5) or be closed to users. Today a user can change their own email unconfirmed, and an invitation goes to whoever holds the address.
  - Rename "Founding organization" (Decision 8). Create no second organization before Phase 2's member management.
  - To run the tenant-isolation suite in CI: two more repository secrets for staging (a database URL and the service-role key), and a `test:tenant-isolation` line in `package.json`.
  - The decisions the Lead took where the criteria were silent (18 to 53) can each be changed before production.
- `.claude/settings.json`: found on 2026-11-25 (14:44) with every line commented out again, which turns the four hooks off (the same edit as on 2026-11-17). Not made by the Lead or an agent as far as known; left as found and not committed. While it stands the Stop gate and the Bash guard do not run: the Lead runs `scripts/gate.sh` by hand.
- **Branch protection on `main`** (require a pull request and passing CI; no force-push; no deletion). `main` is unprotected today. This is the only real control behind "agents never push to or merge into main". It also changes how the owner pushes, so it is the owner's call.
- **The repository is public.** Consider making it private before Phase 1: it will hold the source of a commercial product and a record of its security findings.
- Decisions 1–12 in section 14 of the proposal; Decisions 2, 3, 4 and 8 are needed before Phase 1 can finish.

### P2-6 criteria (written 2026-11-25)

All on staging, with real sign-ins; smallest test code, one check per rule, in the fewest files.

1. The 21 suites of `npm run test:e2e` pass with the Phase 2 clients (the field app and dashboard of this branch). A suite is changed only where a recorded decision changed the behaviour it asserts, and the change is listed.
2. `e2e/saas/members_e2e.py`, `dashboard_orgs_e2e.py` and `tenant_isolation_e2e.py` pass again after the redeploy of `saas-members`.
3. Field app, a person with one membership: nothing new is asked; work entered offline uploads with the organization on the borehole and the photo under `<org>/<user>/`.
4. Field app, a person active in two organizations: they must choose; they then see and upload only that organization's work; a switch is refused while work is unsent, and after a switch nothing of the first organization is on the device.
5. A stand-in for build 1.1.7 (requests shaped as that build sends them: no `org_id`, the old photo path): a person with one membership keeps working unchanged; with two active memberships a new borehole is refused and nothing lands in the wrong organization.
6. RF-118 live: an add for an address held by an unconfirmed account answers 409 and creates nothing.
7. Staging ends as it was found.

### P2-7 criteria (written 2026-11-25)

1. The app is version 1.2.0: `package.json` 1.2.0, Android `versionName` 1.2.0 and `versionCode` 10, and wherever the app shows its own version. Nothing else in those files changes.
2. A debug APK built from this branch with the staging project's address and publishable key installs on the emulator (`Medium_Phone`). No production address or key is in it.
3. `npm run test:apk` and `npm run test:apk-photos` pass on the emulator against staging (the photo captured on the device lands under `<org>/<user>/`).
4. Nothing is published: no store upload, no release signing, no web deploy.

