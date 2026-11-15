# Drill SaaS — Review Findings and Defects

One row per finding. Ids are never reused. Severity and status rules: `docs/saas/WORKFLOW.md` and `.claude/agents/security-reviewer.md`.

Status: Open → Confirmed → Fixed → Verified, or Rejected / Deferred (with reason). "Verified" means a later review or a test confirmed the fix, not the Developer's report.

Source: **TE** = Test Engineer validation, **SR1** / **SR2** = first and second security review, **Lead** = found by the Lead while running the loop.

## Open and deferred

None of these blocks the workflow pull request: there is no open Critical, High or Medium finding. The Low items are scheduled into Phase 0 task P0-6 (guard and scope follow-ups) unless marked otherwise.

| Id | Task | Source | Severity | Finding | Status |
|---|---|---|---|---|---|
| RF-007 | DEMO-1 | TE | Low | `alter table if exists x enable row level security` placed before `create table x` counts, though in Postgres it is a no-op. | Deferred: the catalog check in CI is the authority on RLS and catches it; stated as a limit in the script header. |
| RF-028 | WF-4 | SR2 | Medium | An enforcement file can be edited, used and restored between two snapshots without the scope check seeing it. | Deferred: no cheap control exists inside the working copy (file tools can be restricted, a shell cannot). It needs a deliberate bypass, the same class as the CLI login gap. Stated in WORKFLOW.md and the script header. |
| RF-038 | WF-4 | SR2 | Low | Owner approvals live in `docs/saas/IMPLEMENTATION_STATUS.md`, and a change there by any agent is only a note from the scope check. | Deferred to P0-6 (it was not implemented in WF-5; SR3 caught the row saying otherwise). Until then the Lead reads the `docs/saas/` diff before every commit. |
| RF-040 | WF-2 | SR2 | Info | Whether a hook "ask" produces a prompt in unattended or bypass-permissions runs is unconfirmed. | Open: to be checked before any unattended run. |
| RF-041 | WF-5 | SR3 | Low | The Stop-gate cache key omits the names of untracked files inside an untracked directory, so a rename there can reuse a green result. | Confirmed. P0-6. |
| RF-042 | WF-5 | SR3 | Low | Test files outside `src/**/*.test.ts` and `scripts/**/*.test.mjs` (for example `.test.tsx`) never run and the gate stays green. | Confirmed. P0-6: fail the gate when a test-named file matches no glob. |
| RF-043 | WF-5 | SR3 | Low | Staging allowances are inconsistent with each other and with the rule on destructive operations: a remote `db reset` and mutating management-API calls on staging pass, while `projects delete` asks; `supabase/.temp/` is not a protected path. | Confirmed. Inert while no staging ref is set. Must be settled in P0-6 **before** `STAGING_REF` is set. |
| RF-044 | WF-5 | SR3 | Low | The gate's `npm test` fallback (used only when `tsx` is missing) has no zero-test guard. | Confirmed; not reachable in this repository today. P0-6: a missing `tsx` is a red gate. |
| RF-045 | WF-5 | SR3 | Low | `python3 -m unittest e2e.<module>` is allowed by the guard. | Confirmed. P0-6. The real control is the suites refusing production (P0-3). |
| RF-046 | WF-5 | SR3 | Low | A `__tests__/` folder under `.claude/` or `.github/` counts as test files; `.git/info/exclude`, `.gitattributes` and the Stop-gate key file are unseen by the scope check. | Confirmed. P0-6. |
| RF-048 | WF-5 | SR3 | Info | Once the e2e suites point at staging, the guard will still ask for every e2e run and management script, which would stall autonomous Phase 0 work. | P0-6: change rule 9 once the suites refuse the production project (P0-3). |

Needs the owner (not a defect in the change): `main` has no branch protection on GitHub. Until it does, "agents never push to or merge into main" rests on the tripwire and the agents' instructions.

## Closed

| Id | Task | Source | Severity | Finding | Resolution |
|---|---|---|---|---|---|
| RF-001 | DEMO-1 | TE | High | Nested block comments let a commented-out `enable` count. | Fixed; verified by SR2 and tests. |
| RF-002 | DEMO-1 | TE | High | `/*` inside a string literal hid later `create table` statements. | Fixed; verified by SR2 and tests. |
| RF-003 | DEMO-1 | TE | High | `disable row level security` after an enable was not seen. | Fixed; verified by SR2 and tests. |
| RF-004 | DEMO-1 | TE | High | Rename-and-rebuild let a new table inherit the old one's status. | Fixed; verified by SR2 and tests. |
| RF-005 | DEMO-1 | TE | Medium | `drop table a, b` only saw the first name. | Fixed; verified by SR2 and tests. |
| RF-006 | DEMO-1 | TE | Medium | An unreadable `.sql` file crashed with the exit code that means "tables lack RLS". | Fixed; verified by SR2 and tests. |
| RF-008 | WF-2 | Lead | Low | The scope check blamed agents for the Lead's edits. | Fixed; verified by SR2 (superseded by RF-038). |
| RF-009 | WF-2 | Lead | Low | The Stop hook nudges once per turn while the gate is red by design. | Rejected: intended behaviour. Its cost is addressed in RF-037. |
| RF-010 | WF-2 | SR1 | High | The `DRILL_E2E_TARGET=staging` switch bypassed the guard. | Removed; verified by SR2. |
| RF-011 | WF-2 | SR1 | High | Production reachable through many ordinary command shapes. | Rewritten as an argument-level analyser; SR2: partly. Remainder tracked as RF-025 and RF-034. |
| RF-012 | WF-2 | SR1 | High | Push, force-push and merge denials bypassed by common syntax; over-blocking. | Fixed for every listed syntax; verified by SR2. Remainder tracked as RF-026 and RF-032. |
| RF-013 | WF-2 | SR1 | High | Agents could edit the enforcement files unseen. | Protected-path list added; SR2: partly. Remainder tracked as RF-027 and RF-028. |
| RF-014 | DEMO-1 | SR1 | High | The static migration check cannot be the authority on RLS. | Catalog query added to CI; verified by reading (SR2). Runs for the first time on the pull request. |
| RF-015 | WF-2 | SR1 | Medium | The guard failed open on bad input or a missing tool. | Fixed; verified by SR2. Remainder tracked as RF-035. |
| RF-016 | WF-2 | SR1 | Medium | Secret scan missed the likeliest shapes. | Fixed; verified by SR2. Remainder tracked as RF-036. |
| RF-017 | WF-2 | SR1 | Medium | Scope check blind spots. | Partly fixed; remainder tracked as RF-027. |
| RF-018 | WF-2 | SR1 | Medium | Stop gate only on two branch patterns. | Fixed; verified by SR2. Subagents are covered by the Lead re-running the gate, as documented. |
| RF-019 | WF-2 | SR1 | Medium | CI steps green without checking. | Migration count and catalog RLS steps added; the test-glob part tracked as RF-031. |
| RF-020 | WF-3 | SR1 | Medium | Open findings about the live product would be published. | Policy and git-ignored private folder added; verified by SR2. |
| RF-021 | WF-2 | SR1 | Low | CI actions and CLI on mutable tags. | Pinned; pins verified upstream by the Lead (see RF-030). |
| RF-022 | WF-2 | SR1 | Low | Secret scan printed the matched text. | Fixed; verified by SR2. |
| RF-023 | WF-2 | SR1 | Low | Session-start hook injected repository text as instructions. | Labelled as a record and capped; SR2: partly, the text is still passed through, which the script states. Accepted. |
| RF-024 | WF-3 | SR1 | Low | WORKFLOW.md overstated the guard. | Rewritten; remainder tracked as RF-039. |
| RF-025 | WF-4 | SR2 | Medium | Ordinary ways of running the e2e suites passed the guard. | Fixed in WF-5; verified by SR3 (remainder: RF-045). |
| RF-026 | WF-4 | SR2 | Medium | A plain `git push` while on `main` was allowed. | Fixed in WF-5; verified by SR3. |
| RF-027 | WF-4 | SR2 | Medium | Scope check gaps (modes, quoted names, test-like names under protected paths, `.git` internals, more protected files). | Fixed in WF-5; verified by SR3 (remainder: RF-046). |
| RF-029 | WF-4 | SR2 | Medium | Holes in the staging allowance. | Fixed in WF-5; verified by SR3 (remainder: RF-043). |
| RF-031 | WF-4 | SR2 | Medium | Unit tests outside two folders never ran. | Fixed in WF-5; verified by SR3 (remainders: RF-042, RF-044). |
| RF-032 | WF-4 | SR2 | Low | Other GitHub API routes to a push, merge or protection change. | Fixed for the listed routes; verified by SR3. |
| RF-033 | WF-4 | SR2 | Low | Parser gaps hid the rest of a line. | Fixed; verified by SR3. |
| RF-034 | WF-4 | SR2 | Low | Other production-reaching shapes; harmless commands asking. | Fixed; verified by SR3. |
| RF-035 | WF-4 | SR2 | Low | Residual fail-open paths in the wrapper. | Fixed; verified by SR3. |
| RF-036 | WF-4 | SR2 | Low | Secret-scan misses. | Fixed; verified by SR3. |
| RF-037 | WF-4 | SR2 | Low | The Stop gate ran on every turn regardless of changes. | Fixed with a last-green cache; verified by SR3 (remainder: RF-041). |
| RF-039 | WF-3 | SR2 | Low | Overclaims and stale text. | Fixed by the Lead; SR3 found two more stale lines in WORKFLOW.md, corrected. |
| RF-030 | WF-4 | SR2 | Medium | Nothing in the CI workflow had been run. | Closed: pins verified upstream; first CI run green on pull request 3 (TEST_RESULTS 15). |
| RF-047 | WF-5 | SR3 | Low | The suite had only run on macOS with Node 24. | Closed: green on Ubuntu with Node 22 (TEST_RESULTS 15). |

## Detail

### Third security review (2026-11-15)

Verdict: **NO BLOCKING FINDINGS** — 0 Critical, 0 High, 0 Medium, 8 Low, 4 Info. Scope: the WF-5 fix round. The reviewer verified RF-025 to RF-037, ran about 400 hook invocations with fake refs, 40 scope-check scenarios, the Stop gate in throwaway repositories, and the full gate on a reconstruction of the commit (workflow files only, without the owner's uncommitted work): green, 6 of 6. No regressions; nothing denied wrongly across 143 everyday commands; nothing found that should not be published. It changed no files.

Three deliberate deviations by the Developer, each forced by an existing test, were judged: the access-token exemption is sound; `*.test.*` files under `.claude/` and `.github/` staying test files is acceptable; allowing a remote `db reset` on provable staging contradicts the written rule and must be settled before a staging ref is set (RF-043).

One working rule follows from the guard: a command line containing the production project ref always asks, even in a commit message. Keep the literal ref out of command lines and pass such text by file.

### Second security review (2026-11-15)

Verdict: **CHANGES REQUESTED** — 0 Critical, 0 High, 6 Medium, 8 Low, 3 Info. The reviewer re-verified every first-round finding, ran the guard on about 215 commands with fake refs, exercised the scope check and secret scan in throwaway repositories, and ran the full script suite (1,491 of 1,491). It changed no files.

Its summary, which the Lead accepts: the fix round holds for the migration check, the secret scan, fail-closed input handling and the listed push and merge syntaxes. What remains is silent passes for some ordinary command shapes, holes in the scope check, and a staging allowance that must be tightened before a staging ref is configured.

Also noted: `.claude/skills/apple-design` is a symlink into the owner's `.agents/` folder and must not be committed with the workflow files.

### First security review (2026-11-15)

Verdict: **BLOCK** — 5 High, 6 Medium, 4 Low, 2 Info. The reviewer pipe-tested the guard hook on about 110 commands and ran the migration check on 20 in-memory cases. It changed no files.

The central point, which the Lead accepts: a hook that pattern-matches command text is a tripwire, not a control. The guarantees have to come from removing the capability and from server-side enforcement.

| Guarantee | Real control | Status |
|---|---|---|
| Nothing reaches production | The working copy is not linked to production; scripts and suites refuse to run without an explicit non-production target; the hook asks for anything it cannot prove is local or staging. | Hook rewritten in WF-4. Unlinking and the refusing scripts are Phase 0. |
| Never push to or merge into `main` | GitHub branch protection on `main`. | **Needs the owner**: it changes how the owner pushes too. |
| Enforcement files cannot be changed quietly | Protected-path list in the scope check, plus the owner reading changes to those paths in each pull request. Neither sees a change that is made and reverted between snapshots. | WF-4, WF-5. |
| Every public table has RLS | A catalog query in CI against a fresh database built from the migrations. The static check stays as a fast hint. | WF-4. |

Residual risk the workflow cannot remove: the Supabase CLI login on this machine can reach every project in the account, production included. An agent that deliberately worked around the hook could use it. Only the owner can remove that, with a separate login or machine for agent work.

Info: the production project ref and the link files under `supabase/.temp/` are already tracked on `main`, so the new files expose nothing further. No secrets or personal details were found in the reviewed files.

### Test Engineer validation of DEMO-1 (2026-11-15)

The Test Engineer read the implementation after it passed the original 148 tests and added 27 tests in `validation: …` blocks. 17 failed; 10 were guards that pin behaviour a fix must keep. All 175 pass after the fix round.

### Limits of the static migration check

Probed and judged unrealistic for this repository (no test added, recorded here so the limits are known): enable or drop text inside a string literal or an uncalled function body; a conditional `continue` inside the `foreach` loop; non-ASCII or three-part names; `select … into`; `set schema`; tables created by `execute format('create table …')`; CR-only or UTF-16 files; a second CLI argument being ignored. The catalog check in CI does not share these limits.
