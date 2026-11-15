# Drill SaaS — Development Workflow

How the SaaS work in `docs/SAAS_ARCHITECTURE_PROPOSAL.md` is carried out. This file is the Lead's operating manual; the three files next to it are the record.

| File | Holds |
|---|---|
| `IMPLEMENTATION_STATUS.md` | Current phase, tasks, branches, commits, decisions, blockers, next step |
| `TEST_RESULTS.md` | Every gate and test run that counted, newest first |
| `REVIEW_FINDINGS.md` | Every review finding and defect, with severity and status |

## Roles

| Role | Who | May change |
|---|---|---|
| Lead | The main Claude Code session | `docs/saas/**`, commits, branches, pull requests |
| Developer | `.claude/agents/developer.md` | Application code, migrations, scripts. Never tests. |
| Test Engineer | `.claude/agents/test-engineer.md` | Test files only: `*.test.ts`, `*.test.mjs`, `e2e/**`, `supabase/tests/**` |
| Security Reviewer | `.claude/agents/security-reviewer.md` | Nothing. No edit tools; it has a shell for reading and running checks. The scope check compares file contents, modes and git refs before and after; it would not see a change that was made and then reverted. |

The Lead does not write feature code or tests, and does not review its own orchestration as a substitute for the reviewer. The Lead plans, briefs, runs the deterministic checks, triages, records and commits.

Role boundaries are checked, not trusted. The Lead runs `scripts/check-scope.sh snapshot` before an agent starts and `scripts/check-scope.sh <role> <snapshot-file>` after it returns. While an agent is running, the Lead edits nothing except `docs/saas/`.

**Protected files.** The files that do the enforcing are off limits to every agent unless the Lead's brief names them and the Lead passes `--allow` to the scope check: `.claude/**`, `.github/**`, `scripts/hooks/**`, `scripts/gate.sh`, `scripts/check-*`, `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `capacitor.config.ts`, `netlify.toml`, `.npmrc`, `.mcp.json`, `.gitignore`, and every `CLAUDE.md`. The authoritative list is in `scripts/check-scope.sh`. Git internals (hooks, config, refs) may not change during an agent run at all. A change to any of them is called out in the pull request description so the owner reviews it.

## Resuming a session

A new session starts with the "Current state" section of `IMPLEMENTATION_STATUS.md` already in context (SessionStart hook). Then:

1. Read `IMPLEMENTATION_STATUS.md` in full. It names the phase, the branch, the task in progress and the next step.
2. `git status`, `git log --oneline -10`, and confirm you are on the branch it names. Uncommitted changes belong to the task marked "in progress".
3. Run `scripts/gate.sh quick` to learn the real state of the tree.
4. Read the open rows in `REVIEW_FINDINGS.md`.
5. Continue from "Next step". Do not redo tasks marked done; their evidence is in `TEST_RESULTS.md` and the commits listed.

If the record and the repository disagree, the repository wins: fix the record first, then continue.

## The loop, per task

A phase is split into tasks small enough to review in one sitting. Each task goes through every step.

1. **Plan (Lead).** Add the task to `IMPLEMENTATION_STATUS.md` with its acceptance criteria, taken from the proposal. Set it "in progress".
2. **Tests first (Test Engineer, write mode).** Brief: task id, acceptance criteria, the interface to test against. Expect red tests; record that they fail for the right reason.
3. **Implement (Developer).** Brief: task id, acceptance criteria, files in scope, the tests to satisfy.
4. **Gates (Lead).** `scripts/gate.sh full`, plus the database or e2e suites relevant to the task. Record the run in `TEST_RESULTS.md`. Red goes back to the Developer.
5. **Independent validation (Test Engineer, validate mode)** and **6. Review (Security Reviewer)**, in parallel. Neither sees the other's output.
7. **Triage and fix (Lead, then Developer).** The Lead records every finding in `REVIEW_FINDINGS.md`, confirms each one (reproduce it, or read the code and agree), and sends the confirmed ones to the Developer by id. A finding the Lead rejects is recorded as rejected with the reason.
8. **Repeat 4–7** until the exit conditions hold.
9. **Final validation (Lead).** Re-run the gates from a clean state, re-read the acceptance criteria one by one against evidence, run the scope checks.
10. **Commit** to the phase branch. When the phase's tasks are all done, push and open a pull request. The owner merges.

### Exit conditions for a task

All of these, with evidence recorded:

- Every acceptance criterion has a passing test or a recorded manual check.
- `scripts/gate.sh full` is green, and so are the task's database and e2e suites.
- No open Critical or High finding. Every Medium is fixed, or deferred with a reason and an owner-visible note.
- The Test Engineer's validation run and the Security Reviewer's last report are from **after** the last code change.
- Scope checks pass for every agent run.

"The code is written" is not an exit condition. Neither is "the Developer says it works".

### Briefing an agent

An agent knows only what the brief says. Each brief contains: the task id; the acceptance criteria verbatim; the files or interface in scope; what is already done; what the agent must not do; and what to return. Point to files instead of pasting them. Never tell the reviewer what you expect it to find, and never show the Test Engineer the implementation in write mode.

## Quality gates

Deterministic commands are the primary gates. Agent reviews add to them and never replace them.

| Gate | Command | Runs |
|---|---|---|
| Type check | `npm run lint` (via `scripts/gate.sh`) | Locally, Stop hook, CI |
| Unit tests | `node --import tsx --test "src/**/*.test.ts"`, run by `scripts/gate.sh` | Locally, Stop hook, CI |
| Script tests | `node --test "scripts/**/*.test.mjs"` | Locally, Stop hook, CI |
| Migration static check | `node scripts/check-migrations.mjs` | Locally, on every migration edit, Stop hook, CI |
| Secret scan | `scripts/check-secrets.sh` | Locally, Stop hook, CI |
| Production build | `npm run build` (`gate.sh full`) | Locally, CI |
| Migrations apply to a fresh database | `supabase db start`, then a count of applied migrations against the files | CI |
| Every table in `public` has RLS (the authority; the static check is a hint) | Catalog query on that fresh database | CI |
| Schema lint | `supabase db lint --local` | CI |
| Dependency audit | `npm audit` | CI, informational |
| Role scope | `scripts/check-scope.sh <role> <snapshot-file>` | Lead, after every agent run |

Gates that exist in the plan but not yet in the tree. Each is added by the phase that makes it possible:

| Gate | Added in | Needs |
|---|---|---|
| Existing e2e suites against staging | Phase 0 | Staging project; suites read URL and key from the environment |
| Tenant-isolation suite (`e2e/saas/tenant_isolation_e2e.py`) | Phase 1 | Staging project or local stack |
| Schema check: every `public` table has RLS and `org_id` or is allowlisted | Phase 1 | Same |
| Edge Function authorization tests | Phase 2 | `saas-members` function on staging |
| Offline-sync regression in CI (`e2e/offline_sync_e2e.py`) | Phase 0 | Suites pointed at staging; Playwright in CI |
| Real JSX type checking | Phase 0 | `@types/react` installed and the backlog it reveals triaged |

Known weakness, stated plainly: `npm run lint` does not type-check JSX today, because `@types/react` is not installed. A green type check says nothing about component props. Until Phase 0 fixes that, any `.tsx` change also needs the production build and a rendered check.

## Hooks

Configured in `.claude/settings.json`; scripts in `scripts/hooks/`.

| Hook | When | Effect |
|---|---|---|
| `guard-bash.sh` | Before every shell command, in every agent | A tripwire. Denies the recognisable forms of pushing to `main`, force-pushing and merging pull requests. Asks the owner before Supabase CLI, database-client and Supabase HTTP commands it cannot prove are local or aimed at staging, and before the scripts and suites that default to production. |
| `post-edit.sh` | After every file edit | Runs the check matching the file (migration check, shell syntax, settings JSON) and reports failures to the agent. Never blocks. |
| `stop-gate.sh` | When the Lead tries to end a turn on any branch except `main` | Runs `gate.sh quick`. If red, blocks once and hands back the output. |
| `session-start.sh` | When a session starts | Injects the current state from `IMPLEMENTATION_STATUS.md`, as a record. |

The guard hook reads command text, so it can be evaded by a command shape it does not recognise, or by running a file an agent wrote. It catches mistakes; it does not make a determined bypass impossible. The controls that carry the guarantees are in the next section.

## Production safety

The production Supabase project ref is `bfteveoeodbvjxjlpnwz`. The rule: nothing in this workflow writes to it without the owner approving that specific action. What enforces it, strongest first:

1. **No capability.** From Phase 0 the working copy is linked to staging, not production; the scripts and e2e suites take their target from the environment and refuse to run against the production ref; no production key or password is in the repository or in CI.
2. **Server side.** Branch protection on `main` (the owner's decision; not in place as of 2026-11-15). Migrations reach production only when the owner applies or approves that migration, after it has passed on staging.
3. **The guard hook**, as a tripwire for whatever slips past the first two.
4. **The agents' instructions**, which forbid it.

Known gap: the Supabase CLI login on the owner's machine can reach every project in the account. An agent would have to work around the hook deliberately to use it, but the workflow cannot remove it; a separate login or machine for agent work would.

Until Phase 0 is done, the existing `e2e/*.py` suites and `scripts/{create-user,delete-test-data,check-attribution}.sh` still target production, and are not to be run.

## Publishing findings

This repository is public. Findings about this tooling are recorded in full in `REVIEW_FINDINGS.md`. For a Critical or High finding about the **live product** (for example a tenant-isolation hole), `REVIEW_FINDINGS.md` carries only the id, task, severity and status until it is verified fixed; the detail lives in `docs/saas/private/FINDINGS_DETAIL.md`, which is git-ignored and stays on the owner's machine.

## Autonomy and escalation

Within an approved phase the Lead keeps going: failing tests, review findings and ordinary implementation problems are investigated, fixed and retested without asking.

Stop and ask the owner before:

- Any production migration, deployment, or Edge Function deploy.
- Any destructive database operation, on any project.
- Any change to the approved architecture or to a business rule in the proposal.
- Any new paid service, or exceeding a free tier.
- Anything that trades away security: weakening a policy, widening a grant, skipping an isolation test.
- Starting the next phase.
- A blocker that survived the retry rule below.

Never, under any circumstances: weaken RLS, delete or loosen a test to get green, bypass a failing security test, merge to `main`, or run destructive tests against production.

### Retry rule

Each blocker is tracked in the Blockers table of `IMPLEMENTATION_STATUS.md` with an attempt count. An attempt is a distinct approach, not a re-run.

- Attempts 1–3: investigate, fix, retest.
- After the third failed attempt: stop repeating. Write down what was tried and why each failed, and reassess the approach from the requirement. One further attempt with a different approach is allowed.
- If that fails: escalate to the owner with the evidence. Continue with tasks that do not depend on the blocker.

## Branches and pull requests

- One branch and one pull request per phase: `saas/phase-0-preparation`, `saas/phase-1-tenancy`, and so on. Workflow tooling lives on `chore/agent-workflow`.
- Commit per task, after its exit conditions hold. The message says what changed and why, and names the task id.
- The pull request description lists the tasks, the acceptance criteria with their evidence, open deferred findings, and anything the owner must do (for example, approve a production migration).
- The owner merges. Agents never merge a pull request or push to `main`; the guard hook denies the recognisable forms, and branch protection is what actually prevents it.

## Conventions for the record

- `IMPLEMENTATION_STATUS.md`: keep "Current state" to a few lines and always true. Update it at every task transition, before starting the next agent.
- `TEST_RESULTS.md`: one entry per run that counted — date, commit or "working tree", command, result, and for failures what failed. Newest first. Do not paste full logs.
- `REVIEW_FINDINGS.md`: one row per finding, ids `RF-001` upward, never reused. Status moves Open → Confirmed → Fixed → Verified, or Rejected / Deferred with a reason. A finding is Verified only by a re-review or a test, not by the Developer's word.
