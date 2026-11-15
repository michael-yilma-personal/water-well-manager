# Drill SaaS — Implementation Status

Requirements: `docs/SAAS_ARCHITECTURE_PROPOSAL.md`. How the work is run: `docs/saas/WORKFLOW.md`.

## Current state

- **Phase:** Phase 0 — Preparation (approved). Phase 1 is not approved.
- **Branch:** `saas/phase-0-preparation`, branched from `chore/agent-workflow` at the commit after `8fc667b`. The workflow tooling is pull request 3 (CI green), awaiting the owner's merge.
- **In progress:** P0-1.
- **Next step:** P0-1, then P0-6 (it must precede setting a staging ref), then P0-2 to P0-5, P0-7, P0-8. Stop after Phase 0 and summarise for the owner.
- **Waiting on the owner:** nothing for Phase 0. Phase 1 needs the owner's review of Phase 0 first.

## Phases

| Phase | Branch | Status | Pull request |
|---|---|---|---|
| Workflow setup | `chore/agent-workflow` | Done; CI green; awaiting the owner's merge | https://github.com/michael-yilma-personal/water-well-manager/pull/3 |
| 0 Preparation | `saas/phase-0-preparation` | In progress | — |
| 1 Tenancy in the database | `saas/phase-1-tenancy` | Not approved | — |
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

### Phase 0 — Preparation (approved 2026-11-15)

Acceptance criteria from the proposal: the existing unit and e2e suites pass against staging; production holds no test accounts. Added by the owner: all integration and RLS tests run against staging, never production; no production data is modified.

| Id | Task | Status | Evidence |
|---|---|---|---|
| P0-1 | Commit the owner's pending working-tree changes (unsupported-browser gate, version bump) as their own commit, unchanged | Not started | — |
| P0-6 | Guard and scope follow-ups from the reviews: RF-038, RF-041 to RF-046, RF-048. Settle RF-043 before any staging ref is set | Not started | — |
| P0-2 | Create the staging Supabase project at no cost (separate free organization), apply the six migrations, deploy `admin-users`, create the test accounts there, set `STAGING_REF` | Not started | — |
| P0-3 | e2e suites and management scripts take their target from the environment, contain no hard-coded project URL or key, and refuse to run against the production ref | Not started | — |
| P0-4 | Unlink the working copy from production; stop tracking `supabase/.temp/` | Not started | — |
| P0-5 | Read-only checks on production, each needing the owner's approval at the prompt: the live schema matches the migrations; backups exist; no test accounts remain | Not started | — |
| P0-7 | Real JSX type checking: install `@types/react`, measure the backlog it reveals, fix it if small, otherwise record it | Not started | — |
| P0-8 | Run the RLS and offline-sync suites against staging from CI | Not started | — |

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
