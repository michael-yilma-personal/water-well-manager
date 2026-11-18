# Drill SaaS — Review Findings and Defects

One row per finding. Ids are never reused. Severity and status rules: `docs/saas/WORKFLOW.md` and `.claude/agents/security-reviewer.md`.

Status: Open → Confirmed → Fixed → Verified, or Rejected / Deferred (with reason). "Verified" means a later review or a test confirmed the fix, not the Developer's report.

Source: **TE** = Test Engineer validation, **SR1** / **SR2** = first and second security review, **Lead** = found by the Lead while running the loop.

## Open and deferred

**One Critical finding is mitigated but not resolved: RF-050.** Its detail is kept out of this public file (see WORKFLOW.md, "Publishing findings") and lives in git-ignored files on the owner's machine.

The Low items are scheduled into Phase 0 task P0-6 (guard and scope follow-ups) unless marked otherwise.

| Id | Task | Source | Severity | Finding | Status |
|---|---|---|---|---|---|
| RF-050 | P0-3 | TE | **Critical** | Detail withheld from the public repository (see WORKFLOW.md, "Publishing findings"). | **Mitigated locally; one action by the owner is pending.** Not resolved. Recorded in the git-ignored `docs/saas/SECURITY_TODO.md` and `docs/saas/private/`. It does not block other work. |
| RF-071 | P1-2 | SR9 | **High** | A user's own badge edit copies `profiles.role` into their membership: the profile mirror fires on a role or badge change and writes both, so an account whose profile role is higher than its membership role promotes itself. Reproduced. | Confirmed. Decision 26: the mirror copies only the column that changed. Tests first. |
| RF-072 | P1-2 | SR9 | **High** | The mirror applies service-role profile and ban writes to a membership in any organization, and `admin-users` still authorises on the global `profiles.role`. Once a second organization exists, the founding organization's Administrator can re-role, ban, unban, list and delete the other's accounts; unban also reactivates a membership that was deactivated directly. Database half reproduced; function half by reading. | Confirmed. Decisions 27 and 28: mirroring targets the founding organization only; unban restores only what a ban deactivated; `admin-users` is to require an active Administrator membership and a target in the caller's organization. Tests first. No second organization exists anywhere yet. |
| RF-073 | P1-2 | SR9 | Medium | The Drill migration is safe only as one transaction: between dropping the constant default and creating the fill triggers, an installed build's insert fails with `23502`, which the app treats as permanent. Reproduced. Whether the Supabase CLI applies a file atomically is not verified. | Confirmed. Decision 29: reorder so there is no such window; verify the CLI's behaviour on staging. |
| RF-074 | P1-2 | SR9 | Medium | Legacy photos (`<user_id>/<file>`) become readable by the Administrator of any organization the owner later joins. Criterion 11 said so; the proposal (5.3) says founding organization only. | Confirmed. Decision 30: the proposal wins; criterion 11 and its test tighten. |
| RF-075 | P1-2 | SR9 | Medium | The multi-membership guards on the mirror are untested: with both removed the suite stayed 1,753 of 1,753. Two existing checks assert the behaviour of RF-072 as correct. | Confirmed. Tests added with decisions 26 to 28; a dropped guard must fail a check. |
| RF-076 | P1-2 | SR9 | Medium | With two organizations, an account created by the current dashboard gets no membership; its first borehole is refused permanently. | Confirmed. Decision 27: new profiles enrol in the founding organization until member management replaces `admin-users`. |
| RF-077 | P1-2 | SR9 | Low | Six items. (a) Re-applying the migration re-enrols a removed member. (b) The rollback drops `org_id` even when two organizations hold rows. (c) Helper functions are executable by `anon`; `shares_org_as` lets a member test whether a user id is in their organization. (d) A ban that expires leaves the membership deactivated. (e) A deactivated member can still upload to the legacy path. (f) `run.sh`'s transaction-control check misses `end;`, `abort;`, `commit work;`, and a forwarded port passes its host check. | Decision 31 fixes (a), (b), (c, the `anon` half), (e) and (f, the grep). Accepted and recorded: the member-side oracle in (c); (d), not reachable with the 100-year ban the dashboard uses; the forwarded port in (f). Info, accepted: per-row helper cost (0.45 s over 200k rows); `23503` versus `42501` reveals whether a borehole id exists. |
| RF-078 | WF-4 | Lead | Low | A guard test is not deterministic: "with jq and every interpreter missing from PATH, a push to main is never allowed" failed once in CI (run on `4b14247`, a change to the record only) and passed on the next run with the scripts unchanged. | Open. To be reproduced and fixed by the Test Engineer; it does not affect what the guard does. |
| RF-051 | P0-3 | Lead | Low | The secret scan flags `e2e/target_selftest.py` (a made-up URL with inline credentials used as a refusal case). | Confirmed: the test file must build that string at run time. |
| RF-069 | P0-12 | SR8 | Medium | `gh pr close --delete-branch` is on the known-safe list but can switch to the default branch. Low: `git rm`, `git mv`, `git clean`, `git lfs checkout` are not on the tree-changing list (they cannot restore a production link). The gate's whitespace trimming has only run on macOS awk. | Fixed in P0-13 (TEST_RESULTS 37): `gh pr close` left the safe list; the git commands are documented limits. The first Ubuntu CI run confirms the awk. |
| RF-070 | P0-12 | SR8 | Medium | Publication: the unpushed commits still hold wording that the working tree no longer has. | Push precondition (IMPLEMENTATION_STATUS): the pushed commits are built from the final tree, and a search of everything to be pushed returns no hit. |
| RF-066 | P0-11 | SR7 | High | RF-063 is not closed: an alias (`gh co`) and `gh issue develop --checkout` are still not treated as tree-changing; aliases and extensions cannot be listed. Management scripts after a tree-changing command are allowed. | Confirmed. P0-12: every `gh` subcommand outside a known-safe list counts as tree-changing; management scripts ask after one. Verified by SR8 (360 of 360 cases); remainder RF-069. |
| RF-067 | P0-11 | SR7 | Medium | Publication: wording in the record (RF-060 remainder). | Fixed in the record; working tree verified by SR8. History: RF-070. |
| RF-068 | P0-11 | SR7 | Low | The reworked production-link gate no longer trims form feed and vertical tab (regression), nor a byte-order mark; brace and glob spellings of the link path, and `git read-tree`, `checkout-index`, `sparse-checkout`, are not seen by the guard. | Confirmed. P0-12. A directory option (`tar -C`) and a path built in inline code become documented limits. Verified by SR8. |
| RF-063 | P0-10 | SR6 | High | The GitHub CLI's pull-request checkout (and `gh repo clone`, `gh repo sync`, `hub`) is not treated as a tree-changing command, so a Supabase call, e2e run or `test:*` script after it on the same line is allowed. | Fixed for the listed commands (verified by SR7, about 70 forms); remainder is RF-066. |
| RF-064 | P0-10 | SR6 | Medium | The Stop hook's "unchanged since the last green run" key does not include the git-ignored link file, so a change of the link alone does not re-run the gate. | Fixed; verified by SR7. |
| RF-065 | P0-10 | SR6 | Low | The production-link gate strips all whitespace before comparing, so a link file with a second line compares unequal; a skipped CI staging job shows as a green check; git plumbing and plain file writes to the link file are not seen by the guard. | Fixed and verified by SR7 (CI probe job, about 45 link-path spellings), except the regression and spellings in RF-068. |
| RF-062 | P0-10 | Lead | Low | One guard test (a 400,000-character command line) failed once in the Stop hook's gate run while a second full suite was running. Alone it passes every time, and the hook answers that input at once. The test's 15-second process timeout is exceeded only when two full suites compete. | Confirmed as a load flake, not a behaviour defect. No test changed. Working rule: do not run two full suites at once. To do in Phase 1 housekeeping: make the suite robust to load (longer per-process timeout for the heavy cases, or lower test concurrency). |
| RF-059 | P0-9 | SR5 | High | Checking out `main` or another older branch silently replaces the git-ignored staging link with the tracked production link, and a Supabase call, e2e run or `test:*` script later on the same command line is still allowed. On those branches the guard files do not exist at all. | Guard fix verified by SR6 for all listed git commands and wrappers; gate verified. Remainder (the GitHub CLI's pull-request checkout) is RF-063. The lasting fix is still the owner merging the pull requests. |
| RF-060 | P0-3 | SR5 | High | Publication: wording in the record went beyond "detail withheld" for RF-050. | Fixed before any push; re-checked by SR6 and SR7, which each found further places. All fixed before the first push. |
| RF-061 | P0-9 | SR5 | Low | Directory changes the guard does not follow (`builtin cd`, `command cd`, `chdir`, `npx --prefix`, `find -execdir`, a `cd` that fails); a missing or relative hook `cwd` counts as the root; e2e runs it does not see (a bare file name after `cd` into an unknown folder, dotted module names with `e2e` not first); `supabase link` allowed from the root. | Fixed; verified by SR6 (29 cases). |
| RF-052 | P0-6 | SR4 | High | The guard allows Supabase CLI calls as "linked to staging" from any directory inside the project, but the CLI uses the link of the nearest checkout. In a git worktree or nested checkout made from a commit that still tracks the production link, a push or deploy would be allowed. | Fixed for every static directory form (verified by SR5, about 90 cases); the same-line checkout case is RF-059. |
| RF-053 | P0-6 | SR4 | High | Once a staging ref is set, the guard allows any e2e file or `test:*` script anywhere, on the grounds that the suites refuse production; that is only true of the converted suites in this working tree. | Fixed for other checkouts by path, symlink, directory flags, stdin and dynamic arguments (verified by SR5); remainder is RF-059 and RF-061. |
| RF-054 | P0-6 | SR4 | Medium | Destructive operations on staging run without a prompt, while WORKFLOW.md says to ask on any project. | Fixed; verified by SR5. |
| RF-055 | P0-6 | SR4 | Medium | `GATE_UNIT_TEST_CMD` yields a line reading GATE GREEN with no unit tests run. | Fixed; verified by SR5. |
| RF-056 | P0-6 | SR4 | Low | Guard details: `--version` excuses a destructive call; dot segments and `curl -K` hide a project delete; `bash -n +n` executes; a dynamic word after `env` can override the project ref. | Fixed; verified by SR5. |
| RF-057 | P0-3 | SR4 | Low | `e2e/__pycache__/` was not ignored; README examples for the live project omit `--production`, and the device-suite variable is not named. | Fixed; verified by SR5. |
| RF-058 | P0-3 | SR4 | Info | `e2e/unsupported_browser_e2e.py` builds with `.env.local` (production values). It never signs in or writes, and a build bakes in only the public URL and key. | Accepted as is; noted. |
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
| RF-049 | P0-5 | Lead | Low | Production has an Edge Function named `probe` that is not in the repository. | Investigated (read-only): its whole body returns `{"ok": true}`; a deployment smoke test from 2026-08-06. Recommendation: delete it from production. Waiting for the owner's approval. |

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

### Ninth security review: the Phase 1 migrations (2026-11-17)

Verdict: **BLOCK** — 0 Critical, 2 High, 4 Medium, 6 Low, 2 Info (RF-071 to RF-077). Run at `a4fd18c` on scratch clusters in both grant cases; it changed no files. Direct cross-tenant access through the policies held against every attack tried (forged `org_id`, child row on another organization's borehole, upsert onto foreign ids, moving rows, cross-organization soft delete, `anon` RPC, eight odd storage paths). Both High findings come from the profile and ban mirror. Mutation controls on the record select policy and `shares_org_as` were caught by the suite; removing the mirror's guards was not (RF-075). Six test files were sampled rather than read line by line. Only the real stack can prove: the trigger on `auth.users` and the storage policies under real ownership, the update GoTrue issues on ban and unban, Storage API and PostgREST behaviour, and the hosted Postgres version.

For the owner before any production migration: how the files are applied and proof that it is atomic; no second organization while `admin-users` and the mirror are as they are; accounts with no profile and accounts banned at migration time end with no active membership (check for them first); a signed-out request changes from an empty result to "permission denied"; rollback needs the migration history repaired by hand and is unsafe once two organizations hold data; confirm public signup is disabled.

### Eighth security review: the P0-12 fix (2026-11-16)

Verdict: **CHANGES REQUESTED** — 0 Critical, 0 High, 2 Medium, 2 Low, 3 Info. 360 guard cases (53 tree-changing spellings, each before six targets, plus wrappers and baselines), 17 gate inputs, `scripts/gate.sh quick` once (green). It changed no files. RF-066 and RF-068 hold as specified; no regression; the working tree's wording is clean. Open: RF-069 and RF-070.

### Seventh security review: the P0-11 fix (2026-11-16)

Verdict: **BLOCK** — 1 High, 1 Medium, 3 Low, 3 Info. About 165 guard cases with invented refs against a scratch fixture, the gate's comparison on scratch inputs, `scripts/gate.sh quick` once (green). It changed no files.

Verified: RF-063 for about 70 spellings of the listed commands; RF-064; RF-065 (multi-line, CRLF, case; the probe job receives one secret, outputs only true or false, and fork pull requests get none; about 45 link-path spellings). No rule, hook, CI step or test was loosened, other than the gate regression in RF-068. Info: GitHub counts a skipped job as passing for a required check, so the staging job must not be the only required check if branch protection is added; three untracked folders and files belonging to the owner are not ignored and must not be swept into a commit.

### Existing tests changed in P0-11 (2026-11-16)

Changed by the Test Engineer because RF-065 changed the requirement: the secrets check moved out of the staging job into a separate probe job, so that a run without secrets shows the staging job as skipped rather than passed. In `scripts/ci-workflow.test.mjs`: (1) the "other jobs" helper now also excludes the probe job; (2) "neither is given a secret" now applies to every job other than the staging and probe jobs, and a new test asserts only those two read a secret; (3) the "URL secret is empty or not" check is asserted on the probe job; (4) the "suites were skipped" message must be printed by a job other than the staging job, since a skipped job prints nothing; (5) the describe block was retitled. The test forbidding `continue-on-error` and `|| true` on the staging job is unchanged. No guard, gate or Stop-hook test was changed; tests were only added.

Known limits recorded by the Test Engineer: the self-test's digest scan sees a forbidden value only as a whole quoted literal or whitespace-delimited token; the CI assertions are on the workflow text, so "shown as skipped" is only confirmed by a real run without secrets.

### Sixth security review (2026-11-15)

Verdict: **BLOCK** — 2 High, 2 Medium, 3 Low, 2 Info. About 170 guard cases and 13 gate cases with fake refs; the script suite once (5,731 pass, 0 fail, 1 skipped). It changed no files.

Verified: RF-059 for all sixteen listed git commands through every wrapper and shell form tried; the new gate; RF-061; the CI job's handling of secrets (fork pull requests get none; the three values are staging-only); the package change (two type packages and one dependency, nothing else). All 39 everyday commands from the project root are allowed. Not closed: RF-063 to RF-065, and further publication wording (RF-060).

### Existing tests changed in P0-10 (2026-11-15)

Changed by the Test Engineer because the requirement changed. RF-061: the guard test helper now sends the project directory as the hook's `cwd` (a missing `cwd` is no longer treated as the project root), and six rows that allowed `supabase link` when it named or was linked to staging now expect a prompt (`link` and `unlink` always ask). RF-059: the gate test fixture now includes a `guard.conf`, because the new gate reads it. No assertion was loosened.

### Fifth security review: the P0-9 fix (2026-11-15)

Verdict: **BLOCK** — 2 High, 0 Medium, 4 Low, 2 Info. About 480 guard cases with fake refs against real directory trees (worktree, nested clone, own `supabase/` folder), the script suite once (4,800 pass), the management scripts in dry mode, and a scratch repository to confirm that a checkout overwrites an ignored file. It changed no files.

Verified fixed: RF-054 to RF-057, and every static-directory form of RF-052 and RF-053. Not closed: a tree-changing git command earlier on the same line (RF-059), which the guard cannot see because it reads the link before the line runs; and a publication problem (RF-060), fixed before pushing. Of 113 everyday commands from the project root, 107 are allowed; the six that ask all `cd` to the root through a variable or command substitution first.

### Fourth security review: the Phase 0 changes (2026-11-15)

Verdict: **BLOCK** — 0 Critical, 2 High, 2 Medium, 5 Low, 2 Info. The reviewer read the whole change set, ran about 90 guard cases with fake refs, 38 dry-run cases of the management scripts, 20 URL forms against the e2e target check, and the self-test (91 of 91). It changed no files.

What held: `e2e/_target.py` and the three management scripts refused production in every form tried, before any network or keychain call. No assertion was weakened in any of the 24 converted suites. Nothing in the change set should be withheld from publication; `.env.e2e` and `supabase/.temp/` are ignored.

What did not: the guard's new staging allowances trust facts about this project's root for commands that may run in a different checkout (RF-052, RF-053).

### Existing tests changed in P0-6 (2026-11-15)

Changing an existing test is allowed only when the requirement it pinned has changed. These were changed by the Test Engineer, each because a P0-6 criterion replaced the old rule: the `docs/saas/` "note, not a violation" tests (RF-038); three guard rows allowing a remote `db reset` on linked staging (RF-043); the guard rule 9 tables for e2e files and `test:*` scripts, which now allow once a staging ref is set (RF-048); and two gate tests that relied on the removed `npm test` fallback (RF-044). No assertion was loosened; each now pins the stricter or the replaced rule.

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
