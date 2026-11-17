# Drill SaaS — Implementation Status

Requirements: `docs/SAAS_ARCHITECTURE_PROPOSAL.md`. How the work is run: `docs/saas/WORKFLOW.md`.

## Current state

- **Phase:** Phase 0 — Preparation (approved). Phase 1 is approved to start after Phase 0, on staging only; its production migration is not approved.
- **Branch:** `saas/phase-1-tenancy`, branched from `saas/phase-0-preparation` at `8d07755`. Pull requests 3 (workflow tooling) and 4 (Phase 0) are open with green CI, awaiting the owner's merge, in that order.
- **In progress:** Phase 1, tasks P1-1, P1-2 and P1-4: implemented and green on a throwaway local Postgres (TEST_RESULTS 41); the first run on the real image in CI failed for one cause (TEST_RESULTS 42, criterion 25); the security review is under way. Staging is not touched until both pass.
- **Next step:** fix what CI and the review find; then apply to staging and run P1-3, P1-5, P1-6. **Do not check out `main` or any branch that predates the tooling until the pull requests are merged (RF-059).**
- **Waiting on the owner:** the action recorded for RF-050 (deferred by the owner; does not block development); approval to delete the `probe` function from production (RF-049); confirmation of the staging rule (RF-054); branch protection on `main`; merging the workflow and Phase 0 pull requests so `main` stops carrying the production link files (RF-059).

## Phases

| Phase | Branch | Status | Pull request |
|---|---|---|---|
| Workflow setup | `chore/agent-workflow` | Done; CI green; awaiting the owner's merge | https://github.com/michael-yilma-personal/water-well-manager/pull/3 |
| 0 Preparation | `saas/phase-0-preparation` | Done; CI green; awaiting the owner's merge (after pull request 3) | https://github.com/michael-yilma-personal/water-well-manager/pull/4 |
| 1 Tenancy in the database | `saas/phase-1-tenancy` | Approved to start after Phase 0; production migration not approved | — |
| 2 Organization-aware apps | — | Not approved | — |
| 3 Subscriptions and entitlements | — | Not approved | — |
| 4 Platform console and audit | — | Not approved | — |
| 5 Onboarding polish and cleanup | — | Not approved | — |
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

### Phase 1 — Tenancy in the database (approved to start 2026-11-15; production migration NOT approved)

Requirement: proposal sections 5, 6, 9, 10 and 12. Everything is built and tested on staging. Applying it to production is a separate step that needs the owner's explicit approval of that migration.

Defaults taken where the proposal left a decision open (each can be changed before production): the four roles stay, per organization (Decision 5); the founding organization is created with the name "Founding organization" and renamed by the owner at production time (Decision 8); photo viewing stays as it is today, Administrators only.

| Id | Task | Status | Evidence |
|---|---|---|---|
| P1-1 | Reusable foundation migration `saas_core`: organizations, memberships, platform administrators, audit log, helper functions | Implemented; green locally; CI and review pending | TEST_RESULTS 40, 41 |
| P1-2 | Drill migration `drill_tenancy`: founding organization, memberships from profiles, `org_id` on the four record tables, compatibility triggers for installed builds, organization-scoped policies for tables and photos | Implemented; green locally; CI and review pending; not yet on staging | TEST_RESULTS 40, 41 |
| P1-3 | Tenant-isolation suite `e2e/saas/tenant_isolation_e2e.py` and a fixture that creates a second organization on staging | Not started | — |
| P1-4 | Schema check: every table in `public` has RLS and is organization-scoped or allowlisted; run in CI's database job | Implemented; first CI run pending | TEST_RESULTS 41 |
| P1-5 | Compatibility proof: the 21 existing suites, unchanged, pass against the migrated staging database (the current app sends no `org_id`, so it stands in for the installed 1.1.7 build) | Not started | — |
| P1-6 | Migration rehearsal on staging data: row counts before and after match; every row carries the founding `org_id`; a written rollback script | Not started | — |

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

- Review Phase 0's results and approve Phase 1 (Phase 0 itself is approved).
- **Branch protection on `main`** (require a pull request and passing CI; no force-push; no deletion). `main` is unprotected today. This is the only real control behind "agents never push to or merge into main". It also changes how the owner pushes, so it is the owner's call.
- **The repository is public.** Consider making it private before Phase 1: it will hold the source of a commercial product and a record of its security findings.
- Decisions 1–12 in section 14 of the proposal; Decisions 2, 3, 4 and 8 are needed before Phase 1 can finish.
