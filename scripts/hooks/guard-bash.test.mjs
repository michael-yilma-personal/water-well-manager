// WF-4: the Bash guard hook (scripts/hooks/guard-bash.sh).
//
// Derived from "WF-4 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// (Guard hook, rules 1-10) and from the bypasses recorded in
// docs/saas/REVIEW_FINDINGS.md (RF-010, RF-011, RF-012, RF-015).
//
// The hook is run as a child process with the hook JSON on stdin and
// CLAUDE_PROJECT_DIR pointing at a throwaway directory that holds
// scripts/hooks/guard.conf and, optionally, supabase/.temp/project-ref.
// The project refs below are invented; the real production ref never appears.
//
// One table per rule. Each row is [command, expected decision, short reason].
// Tables titled "assumed reading" pin behaviour the criteria imply but do not
// state; they are listed in the Test Engineer's report for the Lead to confirm.
//
// Run: node --test "scripts/**/*.test.mjs"

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'guard-bash.sh');

const PROD = 'prodrefprodrefprodref1';
const STAGING = 'stagingrefstagingref1';
const OTHER = 'otherrefotherrefother1'; // a third project: neither production nor staging

const ALLOW = 'allow';
const ASK = 'ask';
const DENY = 'deny';

// ---------------------------------------------------------------------------
// Throwaway project directories, one per configuration
// ---------------------------------------------------------------------------

const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});
// The hook above was seen to leave directories behind when this file is run by
// `node --test` (P0-9 write-mode run); the exit handler removes whatever is left.
process.on('exit', () => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Build a project directory. `link` is the content of supabase/.temp/project-ref, or null for no file. */
function makeProject({ prod = PROD, staging = '', link = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-bash-test-'));
  TEMP_DIRS.push(dir);
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'hooks', 'guard.conf'), `PROD_REF=${prod}\nSTAGING_REF=${staging}\n`);
  // Added for RF-061 (P0-10): "a cd to a directory that does not exist when
  // the hook runs makes it unknown". The older tables `cd e2e` and
  // `cd e2e/saas` before an e2e run, so the fixture now really has them.
  mkdirSync(join(dir, 'e2e', 'saas'), { recursive: true });
  if (link !== null) {
    mkdirSync(join(dir, 'supabase', '.temp'), { recursive: true });
    writeFileSync(join(dir, 'supabase', '.temp', 'project-ref'), link);
  }
  return dir;
}

const CONFIGS = {
  // No staging project exists yet.
  none: makeProject({ staging: '', link: null }),
  prodLinked: makeProject({ staging: '', link: PROD }),
  // A staging project exists.
  stagingLinked: makeProject({ staging: STAGING, link: STAGING }),
  stagingSetProdLinked: makeProject({ staging: STAGING, link: PROD }),
  stagingSetNoLink: makeProject({ staging: STAGING, link: null }),
};
const ALL_CONFIGS = Object.keys(CONFIGS);
// For rows whose answer does not depend on staging: the strictest realistic
// configuration and the most permissive one.
const STRICT_AND_PERMISSIVE = ['prodLinked', 'stagingLinked'];

// Expectation profiles for the staging-aware rules (6-8).
/** Uses the linked project: provably staging only when the link file is the staging ref. */
const LINK_DECIDES = { none: ASK, prodLinked: ASK, stagingLinked: ALLOW, stagingSetProdLinked: ASK, stagingSetNoLink: ASK };
/** Names the staging ref literally: provably staging whenever STAGING_REF is configured. */
const NAMES_STAGING = { none: ASK, prodLinked: ASK, stagingLinked: ALLOW, stagingSetProdLinked: ALLOW, stagingSetNoLink: ALLOW };
// P0-6 profiles.
/** RF-048: allowed once STAGING_REF is set, whatever is linked; asks while it is empty. */
const STAGING_SET = { none: ASK, prodLinked: ASK, stagingLinked: ALLOW, stagingSetProdLinked: ALLOW, stagingSetNoLink: ALLOW };
/** Asks in every configuration, including the one where the link file is the staging ref. */
const ASK_EVERYWHERE = { none: ASK, prodLinked: ASK, stagingLinked: ASK, stagingSetProdLinked: ASK, stagingSetNoLink: ASK };

// ---------------------------------------------------------------------------
// Running the hook
// ---------------------------------------------------------------------------

function baseEnv(projectDir) {
  const env = { ...process.env };
  delete env.DRILL_E2E_TARGET; // RF-010: no ambient switch may leak in from the caller
  if (projectDir === null) delete env.CLAUDE_PROJECT_DIR;
  else env.CLAUDE_PROJECT_DIR = projectDir;
  return env;
}

/** Run the hook with raw text on stdin. */
function runRaw(stdin, projectDir = CONFIGS.none, extraEnv = {}) {
  return spawnSync(HOOK, [], {
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...baseEnv(projectDir), ...extraEnv },
  });
}

/**
 * Run the hook for one Bash command line.
 *
 * Changed for RF-061 (P0-10). Before: the hook JSON carried no `cwd`, and the
 * tables that expect a staging allowance relied on a missing `cwd` counting
 * as the project root. Now "a hook cwd that is missing, empty or not absolute
 * is unknown", so the JSON carries `cwd`: the project root, as Claude Code
 * sends it for a command run from there. With no project directory
 * (CLAUDE_PROJECT_DIR unset) no `cwd` is sent; those tests are about rules
 * that do not depend on the directory.
 */
function runCommand(command, projectDir = CONFIGS.none, extraEnv = {}) {
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (projectDir !== null) input.cwd = projectDir;
  return runRaw(JSON.stringify(input), projectDir, extraEnv);
}

/**
 * Run the hook for one Bash command line with a PATH that holds no program at
 * all: no jq, no python3, no node.
 *
 * Changed for RF-078. Before: the hook JSON was handed over with spawnSync's
 * `input`, which is a pipe the parent writes after the child has started.
 * With nothing on PATH the hook exits 2 WITHOUT reading stdin; when it got
 * there before the parent's write, the write failed with EPIPE, spawnSync
 * reported that as `result.error` next to status 2, and decisionOf() below
 * returned "error(... EPIPE)" instead of "exit 2". Which side won was a matter
 * of scheduling, so the test failed now and then on a busy runner although
 * the hook had done exactly what is asserted. Now stdin is a regular file
 * holding the same JSON: nothing is written while the hook runs, so there is
 * nothing to lose a race with, and a hook that does read its input still
 * finds all of it. What is asserted is unchanged.
 */
function runWithEmptyPath(command) {
  const emptyBin = mkdtempSync(join(tmpdir(), 'guard-bash-nopath-'));
  const inputDir = mkdtempSync(join(tmpdir(), 'guard-bash-stdin-'));
  TEMP_DIRS.push(emptyBin, inputDir);
  const inputFile = join(inputDir, 'hook-input.json');
  writeFileSync(inputFile, JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
  const stdin = openSync(inputFile, 'r');
  try {
    return spawnSync('/bin/bash', [HOOK], {
      stdio: [stdin, 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: emptyBin, CLAUDE_PROJECT_DIR: CONFIGS.none, HOME: emptyBin },
    });
  } finally {
    closeSync(stdin);
  }
}

/** 'allow' | 'ask' | 'deny', or a description of anything else the hook did. */
function decisionOf(result) {
  if (result.error) return `error(${result.error.message})`;
  if (result.status !== 0) return `exit ${result.status}`;
  const out = result.stdout.trim();
  if (out === '') return ALLOW;
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return `unparseable stdout: ${out.slice(0, 120)}`;
  }
  return parsed?.hookSpecificOutput?.permissionDecision ?? `no decision in: ${out.slice(0, 120)}`;
}

/** Declare one test per row and configuration. */
function table(title, rows, defaultConfigs = ['none']) {
  describe(title, () => {
    for (const [command, expected, reason] of rows) {
      const perConfig = typeof expected === 'string'
        ? Object.fromEntries(defaultConfigs.map((name) => [name, expected]))
        : expected;
      for (const [configName, want] of Object.entries(perConfig)) {
        it(`${want} [${configName}]: ${JSON.stringify(command)} - ${reason}`, () => {
          const got = decisionOf(runCommand(command, CONFIGS[configName]));
          assert.equal(got, want, `${reason}\ncommand: ${command}\nconfig: ${configName}`);
        });
      }
    }
  });
}

/**
 * A Postgres connection URL, assembled at run time so that this file holds no
 * URL-with-password literal for the secret scan to find.
 */
function pgUrl(host, { password = '', port = '', user = 'postgres' } = {}) {
  const at = String.fromCharCode(64);
  const credentials = password ? [user, password].join(':') : user;
  const authority = port ? [host, port].join(':') : host;
  return ['postgresql', `//${credentials}${at}${authority}/postgres`].join(':');
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

describe('output contract', () => {
  it('allow is exit 0 with nothing on stdout', () => {
    const result = runCommand('git status');
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
  });

  it('deny is exit 0 with a PreToolUse decision and a reason', () => {
    const result = runCommand('git push origin main');
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, DENY);
    assert.equal(typeof out.hookSpecificOutput.permissionDecisionReason, 'string');
    assert.notEqual(out.hookSpecificOutput.permissionDecisionReason.trim(), '');
  });

  it('ask is exit 0 with a PreToolUse decision and a reason', () => {
    const result = runCommand('supabase db push');
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, ASK);
    assert.equal(typeof out.hookSpecificOutput.permissionDecisionReason, 'string');
    assert.notEqual(out.hookSpecificOutput.permissionDecisionReason.trim(), '');
  });
});

// ---------------------------------------------------------------------------
// Configuration: guard.conf and the link file are read from CLAUDE_PROJECT_DIR
// ---------------------------------------------------------------------------

describe('configuration comes from scripts/hooks/guard.conf under CLAUDE_PROJECT_DIR', () => {
  const refA = 'aaaaaaaaaaaaaaaaaaaa';
  const refB = 'bbbbbbbbbbbbbbbbbbbb';
  const projectA = makeProject({ prod: refA });
  const projectB = makeProject({ prod: refB });

  it('the production ref is whatever guard.conf says: ref A asks in project A', () => {
    assert.equal(decisionOf(runCommand(`echo ${refA}`, projectA)), ASK);
  });
  it('ref B is not production in project A', () => {
    assert.equal(decisionOf(runCommand(`echo ${refB}`, projectA)), ALLOW);
  });
  it('ref B asks in project B', () => {
    assert.equal(decisionOf(runCommand(`echo ${refB}`, projectB)), ASK);
  });
  it('ref A is not production in project B', () => {
    assert.equal(decisionOf(runCommand(`echo ${refA}`, projectB)), ALLOW);
  });

  it('without CLAUDE_PROJECT_DIR the hook still denies a push to main (falls back to its own repository)', () => {
    assert.equal(decisionOf(runCommand('git push origin main', null)), DENY);
  });
  it('without CLAUDE_PROJECT_DIR an ordinary command is still allowed', () => {
    assert.equal(decisionOf(runCommand('git status', null)), ALLOW);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 - fail closed
// ---------------------------------------------------------------------------

describe('rule 1: fail closed (exit 2 with a message on stderr)', () => {
  const badInputs = [
    ['', 'empty stdin'],
    ['not json at all', 'stdin is not JSON'],
    ['{"tool_name":"Bash","tool_input":{"command":"git status"', 'truncated JSON'],
    ['{}', 'no tool_input'],
    ['{"tool_name":"Bash"}', 'no tool_input'],
    ['{"tool_name":"Bash","tool_input":{}}', 'no command'],
    ['{"tool_name":"Bash","tool_input":{"command":""}}', 'empty command'],
    ['{"tool_name":"Bash","tool_input":{"command":null}}', 'null command'],
    ['{"tool_name":"Bash","tool_input":{"command":123}}', 'numeric command'],
    ['{"tool_name":"Bash","tool_input":{"command":true}}', 'boolean command'],
    ['{"tool_name":"Bash","tool_input":{"command":["git","push","origin","main"]}}', 'array command'],
    ['{"tool_name":"Bash","tool_input":{"command":{"text":"git push origin main"}}}', 'object command'],
    ['{"tool_name":"Bash","tool_input":"git push origin main"}', 'tool_input is a string'],
    ['[]', 'JSON but not an object'],
    ['"git push origin main"', 'JSON string instead of an object'],
    ['42', 'JSON number instead of an object'],
    ['null', 'JSON null'],
  ];
  for (const [stdin, why] of badInputs) {
    it(`exit 2: ${why} (${JSON.stringify(stdin)})`, () => {
      const result = runRaw(stdin);
      assert.equal(result.status, 2, `expected exit 2, got ${decisionOf(result)}`);
      assert.notEqual(result.stderr.trim(), '', 'expected a message on stderr');
    });
  }

  it('with jq and every interpreter missing from PATH, a push to main is never allowed', () => {
    // An empty PATH: no jq, no python3, no node. The criterion is exit 2. If the
    // hook reaches its interpreter by absolute path it can still decide, and
    // then the only acceptable decision for this command is deny.
    const got = decisionOf(runWithEmptyPath('git push origin main'));
    assert.ok(got === 'exit 2' || got === DENY, `expected exit 2 (or deny), got: ${got}`);
  });

  it('with jq and every interpreter missing from PATH, a production-touching command is never allowed', () => {
    const got = decisionOf(runWithEmptyPath(`supabase link --project-ref ${PROD}`));
    assert.ok(got === 'exit 2' || got === ASK, `expected exit 2 (or ask), got: ${got}`);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 - git push to main/master, --all, --mirror, forced
// ---------------------------------------------------------------------------

table('rule 2: deny a push whose destination is main or master', [
  ['git push origin main', DENY, 'plain main'],
  ['git push origin master', DENY, 'plain master'],
  ['git push -u origin main', DENY, 'flag before the remote'],
  ['git push origin main -u', DENY, 'flag after the refspec'],
  ['git push origin HEAD:main', DENY, 'src:dst'],
  ['git push origin feature:master', DENY, 'src:dst to master'],
  ['git push origin HEAD:refs/heads/main', DENY, 'RF-012: full ref destination'],
  ['git push origin refs/heads/main', DENY, 'full ref'],
  ['git push origin refs/heads/feature:refs/heads/master', DENY, 'full ref on both sides'],
  ['git push origin :main', DENY, 'empty source deletes main'],
  ['git push origin --delete main', DENY, 'deletes main'],
  ['git push origin feature main', DENY, 'second refspec is main'],
  ['git push origin main feature', DENY, 'first refspec is main'],
  ['git push upstream main', DENY, 'another remote name'],
  ['git push "origin" "main"', DENY, 'double-quoted words'],
  ["git push origin 'HEAD:main'", DENY, 'single-quoted refspec'],
  ['git push origin ma""in', DENY, 'quotes inside a word are removed by the shell'],
  ['git   push    origin   main', DENY, 'extra spaces'],
  ['git -C /tmp/repo push origin main', DENY, 'git -C dir push'],
  ['git -C . push origin HEAD:main', DENY, 'git -C dir push with src:dst'],
]);

table('rule 2: deny --all, --mirror and forced pushes', [
  ['git push --all', DENY, 'RF-012: --all includes main'],
  ['git push --all origin', DENY, '--all with a remote'],
  ['git push origin --all', DENY, '--all after the remote'],
  ['git push --mirror origin', DENY, '--mirror includes main'],
  ['git push --force origin feature', DENY, '--force'],
  ['git push origin feature --force', DENY, '--force at the end'],
  ['git push --force', DENY, '--force with no refspec'],
  ['git push --force-with-lease origin feature', DENY, '--force-with-lease'],
  ['git push --force-with-lease=feature:abc123 origin feature', DENY, '--force-with-lease=value'],
  ['git push -f origin feature', DENY, '-f'],
  ['git push origin feature -f', DENY, '-f at the end'],
  ['git push -fu origin feature', DENY, 'RF-012: short group -fu'],
  ['git push -uf origin feature', DENY, 'short group -uf'],
  ['git push -vfu origin feature', DENY, 'short group with f in the middle'],
  ['git push origin +feature', DENY, 'RF-012: + refspec forces'],
  ['git push origin +HEAD:feature', DENY, '+src:dst forces'],
  ['git push origin +main', DENY, '+main'],
  ['git push origin +HEAD:refs/heads/main', DENY, '+ with full ref to main'],
  ['git -C /tmp/repo push -f', DENY, 'git -C dir push -f'],
]);

table('rule 2: every simple command of the line is analysed', [
  ['cd repo && git push origin main', DENY, 'after &&'],
  ['git status; git push origin main', DENY, 'after ;'],
  ['git fetch || git push origin main', DENY, 'after ||'],
  ['echo done | git push origin main', DENY, 'after |'],
  ['git fetch\ngit push origin main', DENY, 'after a newline'],
  ['(git push origin main)', DENY, 'inside a subshell'],
  ['(cd repo && git push origin HEAD:main)', DENY, 'inside a subshell after &&'],
  ['git push origin feature && git push origin main', DENY, 'second push of two'],
  ['git push origin main && git push origin feature', DENY, 'first push of two'],
  ['git status;git push origin main', DENY, 'no space after ;'],
  ['git status&&git push --force origin x', DENY, 'no space around &&'],
  ['bash -c "git push origin main"', DENY, 'bash -c string'],
  ["sh -c 'git push --force origin feature'", DENY, 'sh -c string'],
  ['zsh -c "git push origin HEAD:main"', DENY, 'zsh -c string'],
  ['bash -c "cd repo && git push origin main"', DENY, 'bash -c string with &&'],
  ['eval "git push origin main"', DENY, 'eval string'],
  ['eval git push origin main', DENY, 'eval with separate words'],
  ["bash -c 'bash -c \"git push origin main\"'", DENY, 'nested bash -c'],
]);

table('rule 2: pushes that stay allowed', [
  ['git push', ALLOW, 'no destination named, not forced'],
  ['git push -u origin some-feature-branch', ALLOW, 'feature branch with upstream'],
  ['git push origin saas/phase-0-preparation', ALLOW, 'phase branch'],
  ['git push --set-upstream origin chore/agent-workflow', ALLOW, 'workflow branch'],
  ['git push origin maintenance', ALLOW, 'branch that starts with main'],
  ['git push origin feature/main', ALLOW, 'main is only the last path segment of another branch'],
  ['git push origin fix-main-menu', ALLOW, 'main inside a branch name'],
  ['git push origin mastering', ALLOW, 'branch that starts with master'],
  ['git push origin main:feature-copy', ALLOW, 'main is the source, not the destination'],
  ['git push origin HEAD:refs/heads/feature-x', ALLOW, 'full ref to a feature branch'],
  ['git push origin refs/heads/feature:refs/heads/feature', ALLOW, 'full refs, feature branch'],
  ['git push origin HEAD', ALLOW, 'current branch by HEAD'],
  ['git push -u origin fix-f', ALLOW, 'f in a branch name is not a force flag'],
  ['git push --follow-tags origin feature', ALLOW, 'long flag with an f is not a short-flag group'],
  ['git push origin feature --tags', ALLOW, 'tags'],
  ['git push origin v1.0.0', ALLOW, 'a tag'],
  ['git push -n origin feature', ALLOW, 'dry run'],
  ['git push -v -u origin feature', ALLOW, 'short flags without f'],
  ['git push origin --delete old-feature', ALLOW, 'deletes a feature branch'],
  ['git -C /tmp/repo push -u origin feature', ALLOW, 'git -C dir push of a feature branch'],
  ['cd repo && git push -u origin feature', ALLOW, 'after cd'],
  ['git push origin feature && gh pr create --fill', ALLOW, 'push then open a pull request'],
]);

table('rule 2 (assumed reading): other ways to reach git push', [
  ['git -c push.default=current push origin main', DENY, 'A1: global option -c before push'],
  ['git --no-pager push origin main', DENY, 'A1: global option --no-pager before push'],
  ['GIT_TRACE=1 git push origin main', DENY, 'A2: environment assignment before the command'],
  ['echo $(git push origin main)', DENY, 'A2: command substitution'],
  ['echo `git push origin main`', DENY, 'A2: backtick substitution'],
]);

// ---------------------------------------------------------------------------
// Rule 3 - merging a pull request, changing branch protection
// ---------------------------------------------------------------------------

table('rule 3: deny merging a pull request', [
  ['gh pr merge', DENY, 'bare'],
  ['gh pr merge 12', DENY, 'with a number'],
  ['gh pr merge 12 --squash', DENY, 'flag after'],
  ['gh pr merge --squash 12', DENY, 'flag before the number'],
  ['gh pr merge --auto --merge', DENY, 'auto-merge'],
  ['gh pr merge --admin 12', DENY, 'admin override'],
  ['gh pr --repo owner/repo merge 12', DENY, 'flag between pr and merge'],
  ['gh pr -R owner/repo merge --squash', DENY, 'short flag between pr and merge'],
  ['gh --repo owner/repo pr merge 12', DENY, 'flag between gh and pr'],
  ['gh  pr   merge 12', DENY, 'extra spaces'],
  ['gh "pr" "merge" 12', DENY, 'quoted words'],
  ['gh pr create --fill && gh pr merge --auto', DENY, 'after &&'],
  ['cd repo; gh pr merge 3', DENY, 'after ;'],
  ['bash -c "gh pr merge 3"', DENY, 'bash -c string'],
  ["sh -c 'gh pr merge --squash'", DENY, 'sh -c string'],
  ['eval "gh pr merge 3"', DENY, 'eval string'],
  ['(gh pr merge 3)', DENY, 'subshell'],
  ['gh api -X PUT repos/owner/repo/pulls/5/merge', DENY, 'RF-012: REST merge, -X PUT'],
  ['gh api --method PUT /repos/owner/repo/pulls/5/merge', DENY, 'REST merge, --method PUT'],
  ['gh api --method=PUT repos/owner/repo/pulls/5/merge', DENY, 'REST merge, --method=PUT'],
  ['gh api -XPUT repos/owner/repo/pulls/5/merge', DENY, 'REST merge, -XPUT joined'],
  ['gh api repos/owner/repo/pulls/5/merge -X PUT', DENY, 'method after the path'],
  ['gh api -X put repos/owner/repo/pulls/5/merge', DENY, 'lower-case method'],
  ['gh api -X PUT "repos/owner/repo/pulls/5/merge"', DENY, 'quoted path'],
  ['gh api -X POST repos/owner/repo/pulls/5/merge', DENY, 'any mutating method on a /merge path'],
  ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'", DENY, 'GraphQL mergePullRequest'],
  ['gh api graphql -F query=@merge.graphql -f operationName=mergePullRequest', DENY, 'GraphQL mergePullRequest by name'],
]);

table('rule 3: deny changing branch protection', [
  ['gh api -X PUT repos/owner/repo/branches/main/protection', DENY, 'replace protection'],
  ['gh api -X DELETE repos/owner/repo/branches/main/protection', DENY, 'remove protection'],
  ['gh api --method DELETE /repos/owner/repo/branches/main/protection', DENY, 'remove protection, --method'],
  ['gh api -X PATCH repos/owner/repo/branches/main/protection/required_pull_request_reviews', DENY, 'path contains /protection'],
  ['gh api -X DELETE repos/owner/repo/branches/main/protection/enforce_admins', DENY, 'sub-resource of protection'],
  ['gh api repos/owner/repo/branches/main/protection -X PUT --input protection.json', DENY, 'method after the path'],
]);

table('rule 3: GitHub commands that stay allowed', [
  ['gh pr create --title "Add the guard tests" --body "See WF-4"', ALLOW, 'open a pull request'],
  ['gh pr create --fill', ALLOW, 'open a pull request'],
  ['gh pr view 12', ALLOW, 'read a pull request'],
  ['gh pr view --json state,mergeable', ALLOW, 'read state'],
  ['gh pr list', ALLOW, 'list'],
  ['gh pr checks 12', ALLOW, 'read checks'],
  ['gh pr diff 12', ALLOW, 'read a diff'],
  ['gh pr status', ALLOW, 'read status'],
  ['gh api repos/owner/repo/pulls/5/merge', ALLOW, 'GET: asks whether it is merged'],
  ['gh api -X GET repos/owner/repo/pulls/5/merge', ALLOW, 'explicit GET'],
  ['gh api repos/owner/repo/branches/main/protection', ALLOW, 'GET: reads protection'],
  ['gh api --method GET repos/owner/repo/branches/main/protection', ALLOW, 'explicit GET'],
  ['gh api repos/owner/repo/pulls', ALLOW, 'list pull requests over the API'],
  ['gh run list --branch chore/agent-workflow', ALLOW, 'read CI runs'],
]);

table('rule 3 (assumed reading): gh api sends POST when fields are given', [
  ['gh api repos/owner/repo/pulls/5/merge -f merge_method=squash', DENY, 'A4: -f makes the request a POST'],
  ['gh api repos/owner/repo/branches/main/protection --input protection.json', DENY, 'A4: --input makes the request a POST'],
]);

// ---------------------------------------------------------------------------
// Rule 4 - words inside the arguments of a non-executing command are not commands
// ---------------------------------------------------------------------------

table('rule 4: a mention is not a command', [
  ['git commit -m "never git push origin main"', ALLOW, 'commit message mentions a push to main'],
  ["git commit -m 'block git push --force and gh pr merge'", ALLOW, 'commit message mentions force-push and merge'],
  ['git commit -m "guard: deny gh pr merge"', ALLOW, 'commit message mentions merge'],
  ['git commit -m "fix the hook; git push origin main is denied"', ALLOW, 'a ; inside quotes does not split'],
  ['git commit -m "tests && gh pr merge 1 is denied"', ALLOW, 'an && inside quotes does not split'],
  ['git commit -m "a | git push -f | b"', ALLOW, 'a | inside quotes does not split'],
  ['git commit -am "RF-012: HEAD:refs/heads/main was not caught"', ALLOW, 'commit message with a refspec'],
  ['grep -rn "git push origin main" docs/', ALLOW, 'grep pattern'],
  ["grep -E 'gh +pr +merge' scripts/hooks/guard-bash.sh", ALLOW, 'grep pattern'],
  ['grep -c "push --force" docs/saas/WORKFLOW.md', ALLOW, 'grep pattern'],
  ['rg "gh pr merge" .', ALLOW, 'rg pattern'],
  ['echo "git push origin main"', ALLOW, 'echo prints it'],
  ["printf '%s\\n' 'git push -f origin x'", ALLOW, 'printf prints it'],
  ['git log --grep="push --force"', ALLOW, 'log filter'],
  ['git log --oneline --grep "gh pr merge"', ALLOW, 'log filter'],
  ['gh pr create --title "Deny gh pr merge in the guard" --body "git push origin main is blocked"', ALLOW, 'pull request text'],
  ['gh pr comment 5 --body "do not gh pr merge this yet"', ALLOW, 'comment text'],
  ['gh issue create --title "git push --force is not blocked"', ALLOW, 'issue title'],
  ['git commit -m "document curl to api.supabase.com"', ALLOW, 'mention of a guarded host'],
  ['git commit -m "explain why supabase db push asks"', ALLOW, 'mention of the supabase CLI'],
  ['git commit -m "npm run test:rls now asks"', ALLOW, 'mention of a test:* script'],
  ['grep -rn "create-user.sh" docs/', ALLOW, 'mention of a management script'],
  ['git checkout -b fix/git-push-origin-main', ALLOW, 'branch name that spells the phrase'],
], STRICT_AND_PERMISSIVE);

table('rule 4: quoting does not hide a real command', [
  ['git commit -m "wip" && git push origin main', DENY, 'the push is outside the quotes'],
  ['git commit -m "gh pr merge" ; gh pr merge 4', DENY, 'the merge is outside the quotes'],
  ['echo "safe"; git push --force origin x', DENY, 'the push follows the echo'],
  ['git commit -m \'say "hi"\' && gh pr merge', DENY, 'nested quotes then a real merge'],
]);

table('rule 4 (assumed reading): a here-document body is data', [
  ['git commit -m "$(cat <<\'EOF\'\nDeny git push origin main in the guard\n\ngh pr merge is denied too.\nEOF\n)"', ALLOW, 'A3: commit message from a here-document'],
  ['cat > notes.txt <<EOF\ngit push origin main\nEOF', ALLOW, 'A3: writing a note with a here-document'],
]);

// ---------------------------------------------------------------------------
// Rule 5 - the production ref anywhere in the line
// ---------------------------------------------------------------------------

table('rule 5: ask when the production ref appears anywhere', [
  [`echo ${PROD}`, ASK, 'bare'],
  [`echo "${PROD}"`, ASK, 'double-quoted'],
  [`echo '${PROD}'`, ASK, 'single-quoted'],
  [`supabase link --project-ref ${PROD}`, ASK, 'link to production'],
  [`supabase link --project-ref=${PROD}`, ASK, 'link to production, = form'],
  [`supabase --version # ${PROD}`, ASK, 'in a comment: anywhere means anywhere'],
  [`supabase db reset --local --project-ref ${PROD}`, ASK, '--local does not excuse naming production'],
  [`curl https://${PROD}.supabase.co/rest/v1/`, ASK, 'in a URL'],
  [`curl -s "https://${PROD}.supabase.co/rest/v1/boreholes?select=id"`, ASK, 'in a quoted URL'],
  [`psql -h db.${PROD}.supabase.co -U postgres`, ASK, 'in a host name'],
  [`psql "${pgUrl(`db.${PROD}.supabase.co`, { port: '5432' })}"`, ASK, 'in a connection URL'],
  [`REF=${PROD}; echo done`, ASK, 'in an assignment'],
  [`export SUPABASE_PROJECT_REF=${PROD}`, ASK, 'in an export'],
  [`grep -rn ${PROD} .`, ASK, 'as a grep pattern'],
  [`git commit -m "unlink ${PROD}"`, ASK, 'in a commit message: quoted or not'],
  [`ls && echo ${PROD}`, ASK, 'in a later command'],
  [`bash -c "echo ${PROD}"`, ASK, 'inside bash -c'],
  [`echo x${PROD}x`, ASK, 'inside a longer word'],
], STRICT_AND_PERMISSIVE);

table('rule 5: earlier rules win over the production ask', [
  [`git push origin main # ${PROD}`, DENY, 'rule 2 comes first'],
  [`gh pr merge 1 && echo ${PROD}`, DENY, 'rule 3 comes first'],
  [`echo ${PROD} && git push --force origin x`, DENY, 'deny wins wherever it is in the line'],
], STRICT_AND_PERMISSIVE);

table('rule 5: only the configured production ref triggers it', [
  ['cat supabase/.temp/project-ref', ALLOW, 'reading the link file names no ref'],
  [`echo ${OTHER}`, ALLOW, 'some other twenty-character word'],
  [`echo ${PROD.slice(0, 12)}`, ALLOW, 'a prefix of the production ref'],
], STRICT_AND_PERMISSIVE);

// ---------------------------------------------------------------------------
// Rule 6 - the supabase CLI
// ---------------------------------------------------------------------------

table('rule 6: supabase calls that are always allowed', [
  ['supabase --version', ALLOW, '--version'],
  ['supabase --help', ALLOW, '--help'],
  ['supabase db push --help', ALLOW, '--help on a subcommand'],
  ['supabase start', ALLOW, 'local stack'],
  ['supabase stop', ALLOW, 'local stack'],
  ['supabase status', ALLOW, 'local stack'],
  ['supabase init', ALLOW, 'local files'],
  ['supabase migration new add_organizations', ALLOW, 'creates a local file'],
  ['supabase projects list', ALLOW, 'read-only listing'],
  ['supabase orgs list', ALLOW, 'read-only listing'],
  ['supabase db reset --local', ALLOW, '--local as a real argument'],
  ['supabase db push --local', ALLOW, '--local as a real argument'],
  ['supabase --local db push', ALLOW, '--local before the subcommand'],
  ['supabase migration up --local', ALLOW, '--local as a real argument'],
  ['supabase db lint --local', ALLOW, '--local as a real argument'],
  ['supabase db reset "--local"', ALLOW, 'quoted --local is still a real argument'],
  ['npx supabase start', ALLOW, 'through npx'],
  ['npx supabase db reset --local', ALLOW, 'through npx with --local'],
  ['supabase start && supabase db reset --local', ALLOW, 'two local calls'],
], ALL_CONFIGS);

table('rule 6: supabase calls that always ask', [
  ['supabase projects create drill-staging', ASK, 'projects create always asks'],
  ['supabase projects create drill-staging --org-id abc --region eu-west-1', ASK, 'projects create with flags'],
  ['supabase orgs create drill-free', ASK, 'orgs create always asks'],
  ['supabase projects create drill-staging --local', ASK, 'projects create always asks, even with --local'],
  [`supabase projects create drill-staging --project-ref ${STAGING}`, ASK, 'projects create always asks, even naming staging'],
  [`supabase link --project-ref ${OTHER}`, ASK, 'links to a project that is not staging'],
  [`supabase functions deploy report --project-ref ${OTHER}`, ASK, 'deploys to a project that is not staging'],
  [`supabase projects delete ${OTHER}`, ASK, 'deletes a project that is not staging'],
], ALL_CONFIGS);

table('rule 6: a remote call asks unless the link file is exactly the staging ref', [
  ['supabase db push', LINK_DECIDES, 'changes the linked project'],
  ['supabase db push --dry-run', LINK_DECIDES, 'reads the linked project'],
  ['supabase db push --linked', LINK_DECIDES, 'explicit --linked'],
  // Changed for RF-043 (P0-6): was LINK_DECIDES (allowed when staging is linked).
  ['supabase db reset --linked', ASK_EVERYWHERE, 'RF-043: a non-local reset asks even when staging is linked'],
  ['supabase db dump -f dump.sql', LINK_DECIDES, 'dumps the linked project'],
  ['supabase db pull', LINK_DECIDES, 'reads the linked project'],
  ['supabase db diff --linked', LINK_DECIDES, 'RF-011: verb the old deny-list did not know'],
  ['supabase migration up', LINK_DECIDES, 'applies migrations'],
  ['supabase migration list', LINK_DECIDES, 'RF-011: unlisted verb'],
  ['supabase migration repair --status applied 20260101000000', LINK_DECIDES, 'rewrites migration history'],
  ['supabase functions deploy report', LINK_DECIDES, 'deploys a function'],
  ['supabase functions list', LINK_DECIDES, 'RF-011: unlisted verb'],
  ['supabase secrets set API_KEY=value', LINK_DECIDES, 'sets a secret'],
  ['supabase secrets list', LINK_DECIDES, 'RF-011: unlisted verb'],
  ['supabase inspect db table-sizes', LINK_DECIDES, 'RF-011: unlisted verb'],
  ['supabase gen types typescript --linked', LINK_DECIDES, 'RF-011: unlisted verb'],
  ['supabase storage ls ss:///photos', LINK_DECIDES, 'RF-011: unlisted verb'],
  ['supabase branches list', LINK_DECIDES, 'RF-011: unlisted verb'],
  // Changed for RF-061 (P0-10): was LINK_DECIDES. "supabase link and unlink always ask".
  ['supabase link', ASK_EVERYWHERE, 'RF-061: link with no ref named always asks'],
  ['supabase --debug db push', LINK_DECIDES, 'RF-011: global flag before the verb'],
  ['supabase --workdir . db push', LINK_DECIDES, 'RF-011: global flag with a value'],
  // Changed for RF-043 (P0-6): was LINK_DECIDES.
  ['supabase --yes db reset --linked', ASK_EVERYWHERE, 'RF-011 + RF-043: global flag before the verb; a non-local reset asks'],
  ['npx supabase db push', LINK_DECIDES, 'through npx'],
  ['npx -y supabase@latest db push', LINK_DECIDES, 'through npx with a version'],
  ['./node_modules/.bin/supabase db push', LINK_DECIDES, 'by path'],
  ['cd supabase && supabase db push', LINK_DECIDES, 'RF-011: cd then run'],
  // Changed for RF-043 (P0-6): was LINK_DECIDES.
  ['echo y | supabase db reset --linked', ASK_EVERYWHERE, 'RF-043: piped confirmation; a non-local reset asks'],
  ['SUPABASE_ACCESS_TOKEN=$TOKEN supabase db push', LINK_DECIDES, 'environment assignment first'],
  ['bash -c "supabase db push"', LINK_DECIDES, 'bash -c string'],
  ["sh -c 'supabase migration up'", LINK_DECIDES, 'sh -c string'],
  ['eval "supabase db push"', LINK_DECIDES, 'eval string'],
  ['(supabase db push)', LINK_DECIDES, 'subshell'],
  ['supabase db push # --local', LINK_DECIDES, 'a --local inside a comment does not count'],
  ['supabase db push; echo --local', LINK_DECIDES, 'the --local belongs to another command'],
  ['echo --local && supabase db push', LINK_DECIDES, 'the --local belongs to another command'],
  ['supabase db push --locale', LINK_DECIDES, '--locale is not --local'],
  ['supabase start && supabase db push', LINK_DECIDES, 'a local call does not excuse the remote one'],
  ['supabase db reset --local && supabase db push', LINK_DECIDES, 'the --local belongs to the first call only'],
  [`supabase db push # --project-ref ${STAGING}`, LINK_DECIDES, 'a staging ref inside a comment does not count'],
  [`echo ${STAGING} && supabase db push`, LINK_DECIDES, 'the staging ref belongs to another command'],
]);

// Changed for RF-061 (P0-10). Before: the four `supabase link` rows were
// NAMES_STAGING (allowed once STAGING_REF is configured). The criterion now
// reads "supabase link and unlink always ask": the link is what every
// "linked to staging" allowance rests on, so changing it is the owner's call
// even when the new target is staging. The other rows keep their expectation.
table('rule 6: a call that names the staging ref is allowed once STAGING_REF is configured; link always asks (RF-061)', [
  [`supabase link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'RF-061: link to staging always asks'],
  [`supabase functions deploy report --project-ref ${STAGING}`, NAMES_STAGING, 'deploy to staging'],
  [`supabase secrets list --project-ref ${STAGING}`, NAMES_STAGING, 'read staging'],
  [`supabase --debug link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'RF-061: link, global flag first'],
  [`npx supabase link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'RF-061: link through npx'],
  [`supabase link --project-ref "${STAGING}"`, ASK_EVERYWHERE, 'RF-061: link, quoted ref'],
]);

describe('rule 6: the link file must contain exactly the staging ref', () => {
  const cases = [
    [{ staging: '', link: '' }, 'STAGING_REF empty and an empty link file: empty does not equal empty'],
    [{ staging: '', link: STAGING }, 'STAGING_REF empty: a link file cannot prove staging'],
    [{ staging: STAGING, link: '' }, 'empty link file'],
    [{ staging: STAGING, link: `${STAGING}x` }, 'link file is longer than the staging ref'],
    [{ staging: STAGING, link: STAGING.slice(0, -1) }, 'link file is a prefix of the staging ref'],
    [{ staging: STAGING, link: `${OTHER}\n${STAGING}` }, 'link file holds another ref before the staging ref'],
    [{ staging: STAGING, link: OTHER }, 'link file is a third project'],
  ];
  for (const [config, why] of cases) {
    it(`ask: supabase db push - ${why}`, () => {
      assert.equal(decisionOf(runCommand('supabase db push', makeProject(config))), ASK);
    });
  }

  it('ask: production linked and staging configured, naming production wins over everything', () => {
    assert.equal(decisionOf(runCommand(`supabase db push --project-ref ${PROD}`, CONFIGS.stagingLinked)), ASK);
  });
});

table('rule 6 (assumed reading)', [
  // Changed for RF-061 (P0-10): the A5 row used `supabase link`, which now
  // always asks. A5's own point (the = form names staging) moves to a deploy.
  [`supabase link --project-ref=${STAGING}`, ASK_EVERYWHERE, 'RF-061: link always asks, = form'],
  [`supabase functions deploy report --project-ref=${STAGING}`, NAMES_STAGING, 'A5: --project-ref=<staging> names staging too'],
  ['supabase db push --db-url "$DATABASE_URL"', ASK, 'A6: an explicit target in a variable is not provably staging'],
  ['supabase db dump --db-url $PROD_DB_URL -f dump.sql', ASK, 'A6: an explicit target in a variable is not provably staging'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// Rule 7 - psql, pg_dump, pg_restore
// ---------------------------------------------------------------------------

table('rule 7: a literal local target is allowed', [
  ['psql -h localhost -U postgres -d postgres -c "select 1"', ALLOW, '-h localhost'],
  ['psql -h 127.0.0.1 -p 54322 -U postgres', ALLOW, '-h 127.0.0.1'],
  ['psql --host=localhost --port=54322 -U postgres', ALLOW, '--host=localhost'],
  ['psql --host 127.0.0.1 -U postgres', ALLOW, '--host 127.0.0.1'],
  [`psql ${pgUrl('localhost', { port: '54322' })}`, ALLOW, 'URL to localhost'],
  [`psql "${pgUrl('127.0.0.1', { port: '54322' })}" -c 'select 1'`, ALLOW, 'quoted URL to 127.0.0.1'],
  [`psql "${pgUrl('localhost', { port: '54322', password: 'postgres' })}"`, ALLOW, 'local URL with the local password'],
  ['pg_dump -h localhost -U postgres postgres', ALLOW, 'pg_dump local'],
  ['pg_dump --host=127.0.0.1 -p 54322 -U postgres -f dump.sql postgres', ALLOW, 'pg_dump local'],
  [`pg_dump ${pgUrl('localhost', { port: '54322' })} > dump.sql`, ALLOW, 'pg_dump local URL'],
  ['pg_restore -h localhost -U postgres -d postgres dump.tar', ALLOW, 'pg_restore local'],
  [`pg_restore -d "${pgUrl('127.0.0.1', { port: '54322' })}" dump.tar`, ALLOW, 'pg_restore local URL'],
], STRICT_AND_PERMISSIVE);

table('rule 7: anything else asks', [
  ['psql "$DATABASE_URL"', ASK, 'RF-011: target held in a variable'],
  ['psql $DB_URL -c "select 1"', ASK, 'unquoted variable'],
  ['psql "${DATABASE_URL}" -f seed.sql', ASK, 'braced variable'],
  ['psql -h "$PGHOST" -U postgres', ASK, 'host held in a variable'],
  ['psql', ASK, 'no target: taken from the environment'],
  ['psql -c "select 1"', ASK, 'no target: taken from the environment'],
  ['psql -U postgres -d postgres', ASK, 'no host given'],
  [`psql -h db.${OTHER}.supabase.co -U postgres`, ASK, 'a remote host that is not staging'],
  ['psql -h db.example.com -U postgres', ASK, 'a remote host'],
  [`psql ${pgUrl('db.example.com', { port: '5432' })}`, ASK, 'a remote URL'],
  ['psql -h localhost.example.com -U postgres', ASK, 'localhost only as a prefix of another host'],
  [`psql ${pgUrl('localhost.example.com')}`, ASK, 'localhost only as a prefix of another host, URL form'],
  ['psql -h db.example.com -c "select \'localhost\'"', ASK, 'localhost appears only in the SQL text'],
  ['psql -h db.example.com -c "select 1" # -h localhost', ASK, 'localhost appears only in a comment'],
  ['PGHOST=db.example.com psql -c "select 1"', ASK, 'host from an environment assignment'],
  ['pg_dump "$SUPABASE_DB_URL" > dump.sql', ASK, 'pg_dump of a variable target'],
  ['pg_dump -h db.example.com -U postgres postgres', ASK, 'pg_dump of a remote host'],
  ['pg_restore -d "$DATABASE_URL" dump.tar', ASK, 'pg_restore to a variable target'],
  ['pg_restore -h db.example.com -d postgres dump.tar', ASK, 'pg_restore to a remote host'],
  ['cd supabase && psql "$DATABASE_URL" -f seed.sql', ASK, 'after cd'],
  ['bash -c \'psql "$DATABASE_URL"\'', ASK, 'bash -c string'],
  ['cat seed.sql | psql "$DATABASE_URL"', ASK, 'at the end of a pipe'],
  ['psql -h localhost -c "select 1" && psql "$DATABASE_URL"', ASK, 'a local call does not excuse the remote one'],
], STRICT_AND_PERMISSIVE);

table('rule 7: a literal containing the staging ref is allowed once STAGING_REF is configured', [
  [`psql -h db.${STAGING}.supabase.co -U postgres`, NAMES_STAGING, 'staging host'],
  [`psql "${pgUrl(`db.${STAGING}.supabase.co`, { port: '5432' })}"`, NAMES_STAGING, 'staging URL'],
  [`pg_dump -h db.${STAGING}.supabase.co -U postgres postgres`, NAMES_STAGING, 'pg_dump of staging'],
  [`pg_restore -d "${pgUrl(`db.${STAGING}.supabase.co`, { port: '5432' })}" dump.tar`, NAMES_STAGING, 'pg_restore to staging'],
]);

table('rule 7 (assumed reading)', [
  ['/opt/homebrew/bin/psql "$DATABASE_URL"', ASK, 'A7: the client reached by path'],
], STRICT_AND_PERMISSIVE);

// ---------------------------------------------------------------------------
// Rule 8 - curl and wget to Supabase
// ---------------------------------------------------------------------------

table('rule 8: curl or wget to a Supabase host asks', [
  [`curl https://${OTHER}.supabase.co/rest/v1/boreholes`, ASK, 'a project host'],
  [`curl -s "https://${OTHER}.supabase.co/auth/v1/token?grant_type=password" -d '{}'`, ASK, 'quoted project URL'],
  [`curl -X DELETE "https://${OTHER}.supabase.co/rest/v1/boreholes?id=eq.1"`, ASK, 'a mutating request'],
  [`wget https://${OTHER}.supabase.co/storage/v1/object/public/photos/a.jpg`, ASK, 'wget to a project host'],
  [`wget -q -O - "https://${OTHER}.supabase.co/rest/v1/"`, ASK, 'wget with flags'],
  ['curl https://api.supabase.com/v1/projects', ASK, 'management API'],
  ['curl -H "Authorization: Bearer $TOKEN" https://api.supabase.com/v1/projects', ASK, 'management API with a header first'],
  ['curl -X POST https://api.supabase.com/v1/projects -d @project.json', ASK, 'management API, creating'],
  ['wget https://api.supabase.com/v1/organizations', ASK, 'management API with wget'],
  ['curl "$SUPABASE_URL/rest/v1/boreholes"', ASK, 'RF-011: URL built from a SUPABASE variable'],
  ['curl $SUPABASE_URL/rest/v1/boreholes', ASK, 'unquoted SUPABASE variable'],
  ['curl "${VITE_SUPABASE_URL}/rest/v1/boreholes"', ASK, 'variable whose name contains SUPABASE'],
  ['curl -X DELETE "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/boreholes?id=eq.1"', ASK, 'variable whose name contains SUPABASE'],
  ['wget "$SUPABASE_URL/rest/v1/boreholes"', ASK, 'wget with a SUPABASE variable'],
  ['curl -s "$SUPABASE_URL/rest/v1/boreholes" | jq .', ASK, 'at the start of a pipe'],
  ['cd e2e && curl "$SUPABASE_URL/rest/v1/"', ASK, 'after cd'],
  ['bash -c \'curl "$SUPABASE_URL/rest/v1/"\'', ASK, 'bash -c string'],
  [`curl https://example.com/health https://${OTHER}.supabase.co/rest/v1/`, ASK, 'second URL is a project host'],
  ['curl https://example.com/health && curl https://api.supabase.com/v1/projects', ASK, 'second call is the management API'],
], STRICT_AND_PERMISSIVE);

table('rule 8: other hosts stay allowed', [
  ['curl https://example.com', ALLOW, 'an ordinary host'],
  ['curl -s http://localhost:5173/', ALLOW, 'the dev server'],
  ['curl http://127.0.0.1:54321/rest/v1/', ALLOW, 'the local stack'],
  ['curl -I https://77builders.com/drill/', ALLOW, 'the deployed web app'],
  ['wget https://nodejs.org/dist/index.json', ALLOW, 'an ordinary host'],
  ['curl "$API_URL/health"', ALLOW, 'a variable with no SUPABASE in its name'],
  ['curl -s https://registry.npmjs.org/tsx | jq .version', ALLOW, 'the npm registry'],
  ['curl https://example.com/docs/supabase.co.html', ALLOW, 'supabase.co only in the path of another host'],
], STRICT_AND_PERMISSIVE);

table('rule 8: a literal URL containing the staging ref is allowed once STAGING_REF is configured', [
  [`curl https://${STAGING}.supabase.co/rest/v1/`, NAMES_STAGING, 'staging project host'],
  [`curl -s "https://${STAGING}.supabase.co/rest/v1/boreholes?select=id" -H "apikey: $SUPABASE_ANON_KEY"`, NAMES_STAGING, 'staging URL; the variable is in a header, not the URL'],
  [`wget https://${STAGING}.supabase.co/storage/v1/object/public/photos/a.jpg`, NAMES_STAGING, 'wget to staging'],
  [`curl https://api.supabase.com/v1/projects/${STAGING}`, NAMES_STAGING, 'management API for the staging project'],
]);

table('rule 8: staging does not excuse another target on the same line', [
  [`curl https://${STAGING}.supabase.co/rest/v1/ https://${OTHER}.supabase.co/rest/v1/`, ASK, 'the second URL is another project'],
  [`curl https://${STAGING}.supabase.co/rest/v1/ && curl "$SUPABASE_URL/rest/v1/"`, ASK, 'the second call uses a variable'],
  [`curl "$SUPABASE_URL/rest/v1/" # ${STAGING}`, ASK, 'the staging ref is only in a comment'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// Rule 9 - management scripts, e2e Python, test:* package scripts
// ---------------------------------------------------------------------------

table('rule 9: management scripts ask however they are reached', [
  ['scripts/create-user.sh a@example.com', ASK, 'by relative path'],
  ['./scripts/create-user.sh a@example.com', ASK, 'by ./ path'],
  ['bash scripts/create-user.sh a@example.com', ASK, 'through bash'],
  ['sh ./scripts/delete-test-data.sh', ASK, 'through sh'],
  ['zsh scripts/check-attribution.sh', ASK, 'through zsh'],
  ['bash -x scripts/delete-test-data.sh', ASK, 'through bash with a flag'],
  ['cd scripts && ./create-user.sh a@example.com', ASK, 'RF-011: cd then run'],
  ['cd scripts; bash delete-test-data.sh', ASK, 'cd then bash'],
  ['(cd scripts && ./check-attribution.sh)', ASK, 'cd in a subshell'],
  ['/Users/someone/dev/repo/scripts/check-attribution.sh', ASK, 'by absolute path'],
  ['source scripts/create-user.sh', ASK, 'sourced'],
  ['. scripts/delete-test-data.sh', ASK, 'sourced with a dot'],
  ['bash -c "scripts/create-user.sh a@example.com"', ASK, 'bash -c string'],
  ['npm run build && scripts/delete-test-data.sh', ASK, 'after &&'],
  ['DRILL_E2E_TARGET=staging scripts/create-user.sh a@example.com', ASK, 'RF-010: no environment escape hatch'],
  ['DRILL_E2E_TARGET=staging bash scripts/delete-test-data.sh', ASK, 'RF-010: no environment escape hatch'],
  ['export DRILL_E2E_TARGET=staging; scripts/check-attribution.sh', ASK, 'RF-010: exported first'],
], STRICT_AND_PERMISSIVE);

// Changed for RF-048 (P0-6). Before: every row asked in every configuration
// (title "any Python file under e2e/ asks", run under prodLinked and
// stagingLinked). Now: asks while STAGING_REF is empty, allowed once it is
// set, because the suites refuse production themselves (P0-3). The RF-010
// rows keep their point: the variable is not what decides.
table('rule 9: a Python file under e2e/ asks while STAGING_REF is empty and is allowed once it is set (RF-048)', [
  ['python3 e2e/rls_e2e.py', STAGING_SET, 'python3'],
  ['python e2e/rls_e2e.py', STAGING_SET, 'python'],
  ['python3 ./e2e/rls_e2e.py', STAGING_SET, './ path'],
  ['python3 e2e/saas/tenant_isolation.py', STAGING_SET, 'a subdirectory'],
  ['python3 e2e/brand_new_suite.py', STAGING_SET, 'a suite nobody has listed'],
  ['python3 -u e2e/rls_e2e.py', STAGING_SET, 'interpreter flag first'],
  ['python3 e2e/rls_e2e.py --verbose', STAGING_SET, 'with arguments'],
  ['./e2e/rls_e2e.py', STAGING_SET, 'executed directly'],
  ['cd e2e && python3 rls_e2e.py', STAGING_SET, 'RF-011: cd then run'],
  ['cd e2e; python3 ./rls_e2e.py', STAGING_SET, 'cd then run with ./'],
  ['cd e2e/saas && python3 tenant_isolation.py', STAGING_SET, 'cd into a subdirectory'],
  ['(cd e2e && python3 rls_e2e.py)', STAGING_SET, 'cd in a subshell'],
  ['python3 -m e2e.rls_e2e', STAGING_SET, 'as a module'],
  ['python -m e2e.saas.tenant_isolation', STAGING_SET, 'as a nested module'],
  ['bash -c "python3 e2e/rls_e2e.py"', STAGING_SET, 'bash -c string'],
  ['npm test && python3 e2e/rls_e2e.py', STAGING_SET, 'after &&'],
  ['DRILL_E2E_TARGET=staging python3 e2e/rls_e2e.py', STAGING_SET, 'RF-010: the variable is not an escape hatch while STAGING_REF is empty'],
  ['env DRILL_E2E_TARGET=staging python3 e2e/rls_e2e.py', STAGING_SET, 'RF-010: through env'],
  ['export DRILL_E2E_TARGET=staging && python3 e2e/rls_e2e.py', STAGING_SET, 'RF-010: exported first'],
]);

// Changed for RF-048 (P0-6). Before: every row asked in every configuration
// (title "any test:* package script asks, with any runner", run under
// prodLinked and stagingLinked). Now: asks while STAGING_REF is empty,
// allowed once it is set.
table('rule 9: a test:* package script asks while STAGING_REF is empty and is allowed once it is set, with any runner (RF-048)', [
  ['npm run test:rls', STAGING_SET, 'npm run'],
  ['npm run test:e2e', STAGING_SET, 'the umbrella script'],
  ['npm run test:something-new', STAGING_SET, 'a script nobody has listed'],
  ['npm run test:rls -- --verbose', STAGING_SET, 'with arguments'],
  ['npm run-script test:rls', STAGING_SET, 'RF-011: npm run-script'],
  ['npm run --silent test:rls', STAGING_SET, 'flag between run and the script'],
  ['npm --silent run test:rls', STAGING_SET, 'flag before run'],
  ['npm run "test:rls"', STAGING_SET, 'quoted script name'],
  ['yarn test:rls', STAGING_SET, 'RF-011: yarn'],
  ['yarn run test:rls', STAGING_SET, 'yarn run'],
  ['pnpm test:rls', STAGING_SET, 'RF-011: pnpm'],
  ['pnpm run test:rls', STAGING_SET, 'pnpm run'],
  ['bun run test:rls', STAGING_SET, 'RF-011: bun run'],
  ['npm test && npm run test:rls', STAGING_SET, 'after a plain npm test'],
  ['cd . && npm run test:sync', STAGING_SET, 'after cd'],
  ['bash -c "npm run test:rls"', STAGING_SET, 'bash -c string'],
  ['DRILL_E2E_TARGET=staging npm run test:rls', STAGING_SET, 'RF-010: the variable is not an escape hatch while STAGING_REF is empty'],
  ['DRILL_E2E_TARGET=staging npm run test:e2e', STAGING_SET, 'RF-010: the variable is not an escape hatch while STAGING_REF is empty'],
  ['export DRILL_E2E_TARGET=staging; npm run test:rls', STAGING_SET, 'RF-010: exported first'],
]);

// Changed for RF-048 (P0-6). Before: all four commands asked under prodLinked
// and under stagingLinked. Now the variable still changes nothing, but what
// "nothing" is depends on STAGING_REF: the test script and the e2e file are
// allowed once it is set; the management scripts (no SUPABASE_PROJECT_REF on
// the line) ask in every configuration.
describe('rule 9: DRILL_E2E_TARGET=staging in the hook environment changes nothing (RF-010)', () => {
  const rows = [
    ['npm run test:rls', STAGING_SET],
    ['python3 e2e/rls_e2e.py', STAGING_SET],
    ['scripts/create-user.sh a@example.com', ASK_EVERYWHERE],
    ['scripts/delete-test-data.sh', ASK_EVERYWHERE],
  ];
  for (const [command, profile] of rows) {
    for (const [configName, want] of Object.entries(profile)) {
      it(`${want} [${configName}]: ${command}`, () => {
        const result = runCommand(command, CONFIGS[configName], { DRILL_E2E_TARGET: 'staging' });
        assert.equal(decisionOf(result), want);
      });
    }
  }
});

table('rule 9: what stays allowed', [
  ['npm test', ALLOW, 'plain npm test'],
  ['npm run test', ALLOW, 'the plain test script by its full name'],
  ['npm test -- --test-name-pattern=guard', ALLOW, 'plain npm test with arguments'],
  ['npm run build', ALLOW, 'build'],
  ['npm run lint', ALLOW, 'lint'],
  ['python3 -c "print(1)"', ALLOW, 'inline Python'],
  ['python3 scripts/tool.py', ALLOW, 'a Python file outside e2e/'],
  ['python3 -m http.server 8000', ALLOW, 'a module outside e2e'],
  ['scripts/gate.sh quick', ALLOW, 'the gate'],
  ['scripts/check-scope.sh snapshot', ALLOW, 'the scope check'],
  ['scripts/check-secrets.sh', ALLOW, 'the secret scan'],
  ['bash scripts/my-create-user.sh', ALLOW, 'a different basename'],
  ['cat scripts/create-user.sh', ALLOW, 'rule 4: reading a management script'],
  ['git add scripts/delete-test-data.sh', ALLOW, 'rule 4: staging a management script'],
  ['git diff -- e2e/rls_e2e.py', ALLOW, 'rule 4: diffing an e2e file'],
  ['git add e2e/saas/tenant_isolation.py', ALLOW, 'rule 4: staging an e2e file'],
  ['ls e2e', ALLOW, 'listing e2e/'],
  ['wc -l e2e/rls_e2e.py', ALLOW, 'rule 4: counting lines of an e2e file'],
], STRICT_AND_PERMISSIVE);

// ---------------------------------------------------------------------------
// Rule 10 - everything else is allowed
// ---------------------------------------------------------------------------

table('rule 10: ordinary commands are allowed', [
  ['git status', ALLOW, 'status'],
  ['git status --short', ALLOW, 'status'],
  ['git diff', ALLOW, 'diff'],
  ['git log --oneline -5', ALLOW, 'log'],
  ['git add -A && git commit -m "Add the guard tests"', ALLOW, 'commit'],
  ['git checkout -b saas/phase-0-preparation', ALLOW, 'new branch'],
  ['git fetch origin', ALLOW, 'fetch'],
  ['git pull --ff-only', ALLOW, 'pull'],
  ['git merge --ff-only origin/chore/agent-workflow', ALLOW, 'a local merge of a feature branch'],
  ['git push -u origin some-feature-branch', ALLOW, 'push a feature branch'],
  ['git push origin saas/phase-0-preparation', ALLOW, 'push the phase branch'],
  ['npm test', ALLOW, 'unit tests'],
  ['npm run build', ALLOW, 'build'],
  ['npm run lint', ALLOW, 'type check'],
  ['npm ci', ALLOW, 'install'],
  ['npx tsc --noEmit', ALLOW, 'type check through npx'],
  ['scripts/gate.sh quick', ALLOW, 'quick gate'],
  ['scripts/gate.sh full', ALLOW, 'full gate'],
  ['node --test "scripts/**/*.test.mjs"', ALLOW, 'script tests'],
  ['node --import tsx --test "src/services/*.test.ts"', ALLOW, 'unit tests directly'],
  ['node scripts/check-migrations.mjs', ALLOW, 'migration check'],
  ['gh pr create --title "WF-4" --body "Harden the enforcement"', ALLOW, 'open a pull request'],
  ['gh pr view', ALLOW, 'read a pull request'],
  ['gh pr view 12 --json state', ALLOW, 'read a pull request'],
  ['ls', ALLOW, 'list'],
  ['ls -la supabase/migrations', ALLOW, 'list migrations'],
  ['cat package.json | jq .scripts', ALLOW, 'read package scripts'],
  ['python3 -c "print(1)"', ALLOW, 'inline Python'],
  ['mkdir -p docs/saas && touch docs/saas/notes.md', ALLOW, 'files'],
  ['echo "main"', ALLOW, 'a word that happens to be main'],
  ['cd /tmp && ls; pwd', ALLOW, 'several simple commands'],
  ['FOO=bar node -e "console.log(process.env.FOO)"', ALLOW, 'environment assignment first'],
  ['for f in scripts/*.sh; do bash -n "$f"; done', ALLOW, 'a loop'],
], STRICT_AND_PERMISSIVE);

// ===========================================================================
// WF-4 validation (after implementation)
//
// First the Lead's rulings made after the tests above were written, (a) to
// (e); they are part of the requirement. Then the "validation: ..." blocks:
// behaviour found by reading the implementation and trying to break it. A
// "validation" block that is red is a finding for the Lead, classified in the
// Test Engineer's report as a defect against the criteria or as hardening
// beyond them.
// ===========================================================================

// ---------------------------------------------------------------------------
// Ruling (a) - gh api with a mutating method on a path ending /merges
// ---------------------------------------------------------------------------

table('ruling (a): gh api with a mutating method on a path ending /merges is denied', [
  ['gh api -X POST repos/owner/repo/merges -f base=main -f head=feature', DENY, 'REST branch merge, -X POST'],
  ['gh api --method POST /repos/owner/repo/merges -f base=main -f head=feature', DENY, '--method POST, leading slash'],
  ['gh api --method=POST repos/owner/repo/merges --input merge.json', DENY, '--method=POST with a body file'],
  ['gh api -XPOST repos/owner/repo/merges', DENY, '-XPOST joined'],
  ['gh api repos/owner/repo/merges -X POST', DENY, 'method after the path'],
  ['gh api -X post repos/owner/repo/merges', DENY, 'lower-case method'],
  ['gh api -X PUT repos/owner/repo/merges', DENY, 'any mutating method'],
  ['gh api -X POST "repos/owner/repo/merges"', DENY, 'quoted path'],
  ['gh api -X POST repos/owner/repo/merges/', DENY, 'trailing slash'],
  ['gh api -X POST "repos/owner/repo/merges?per_page=1"', DENY, 'query string after the path'],
  ['gh api -X POST https://api.github.com/repos/owner/repo/merges', DENY, 'full URL'],
  ['gh api -X POST "repos/$OWNER/$REPO/merges" -f base=main -f head=x', DENY, 'variables in the path, literal ending'],
  ['gh api repos/owner/repo/merges -f base=main -f head=feature', DENY, 'fields make the request a POST'],
  ['gh api repos/owner/repo/merges --input merge.json', DENY, '--input makes the request a POST'],
  ['gh api -X "$METHOD" repos/owner/repo/merges', DENY, 'a method held in a variable is not provably GET'],
  ['cd repo && gh api -X POST repos/owner/repo/merges -f base=main -f head=x', DENY, 'after &&'],
  ['bash -c "gh api -X POST repos/owner/repo/merges -f base=main -f head=x"', DENY, 'bash -c string'],
], STRICT_AND_PERMISSIVE);

table('ruling (a): reading and look-alike paths stay allowed', [
  ['gh api repos/owner/repo/merges', ALLOW, 'no method, no fields: a GET'],
  ['gh api -X GET repos/owner/repo/merges', ALLOW, 'explicit GET'],
  ['gh api --method HEAD repos/owner/repo/merges', ALLOW, 'explicit HEAD'],
  ['gh api -X POST repos/owner/repo/issues/5/comments -f body="see /merges"', ALLOW, '/merges only inside a field value'],
  ['gh api -X POST repos/owner/repo/merges-report/dispatches', ALLOW, 'a path that only starts a segment with merges'],
  ['git commit -m "deny gh api -X POST repos/o/r/merges"', ALLOW, 'rule 4: a mention'],
], STRICT_AND_PERMISSIVE);

// ---------------------------------------------------------------------------
// Ruling (b) - rule 8: where the staging ref must be for a URL to be staging
// ---------------------------------------------------------------------------

table('ruling (b): the staging ref as a host label or as the project segment is staging', [
  [`curl https://${STAGING}.supabase.co/rest/v1/boreholes?select=id`, NAMES_STAGING, 'the first host label'],
  [`curl https://db.${STAGING}.supabase.co/health`, NAMES_STAGING, 'an inner host label'],
  [`curl https://${STAGING}.supabase.co:443/rest/v1/`, NAMES_STAGING, 'host with a port'],
  [`curl ${STAGING}.supabase.co/rest/v1/`, NAMES_STAGING, 'no scheme'],
  [`curl --url https://${STAGING}.supabase.co/rest/v1/`, NAMES_STAGING, 'given with --url'],
  [`wget -q -O - https://${STAGING}.supabase.co/rest/v1/`, NAMES_STAGING, 'wget'],
  [`curl https://api.supabase.com/v1/projects/${STAGING}`, NAMES_STAGING, 'management API: the project itself'],
  [`curl https://api.supabase.com/v1/projects/${STAGING}/database/query -d @query.json`, NAMES_STAGING, 'management API: under the project'],
  [`curl "https://api.supabase.com/v1/projects/${STAGING}?fields=name"`, NAMES_STAGING, 'management API: project then a query'],
  [`curl "https://${STAGING}.supabase.co/rest/v1/$SUPABASE_TABLE"`, NAMES_STAGING, 'a SUPABASE variable in the path of a literal staging host'],
]);

table('ruling (b): a staging ref anywhere else in the URL still asks', [
  [`curl "https://${OTHER}.supabase.co/rest/v1/boreholes?ref=${STAGING}"`, ASK, "in the query string of another project's host"],
  [`curl https://${OTHER}.supabase.co/${STAGING}/rest/v1/`, ASK, "in the path of another project's host"],
  [`curl "https://${OTHER}.supabase.co/rest/v1/#${STAGING}"`, ASK, "in the fragment of another project's host"],
  [`wget "https://${OTHER}.supabase.co/rest/v1/?ref=${STAGING}"`, ASK, 'wget, in the query string'],
  [`curl "https://api.supabase.com/v1/projects/${OTHER}?ref=${STAGING}"`, ASK, 'management API: another project, staging in the query'],
  [`curl https://api.supabase.com/v1/projects/${OTHER}/branches/${STAGING}`, ASK, 'management API: another project, staging later in the path'],
  [`curl https://api.supabase.com/v1/organizations/${STAGING}`, ASK, 'management API: not under /v1/projects/'],
  [`curl "https://api.supabase.com/v1/projects?ref=${STAGING}"`, ASK, 'management API: the project list, staging in the query'],
  [`curl https://api.supabase.com/v1/projects/${STAGING}x/database/query`, ASK, 'management API: a project whose ref only starts with the staging ref'],
  [`curl https://api.supabase.com/v2/projects/${STAGING}`, ASK, 'management API: not the /v1/projects/ path'],
  [`curl https://x${STAGING}.supabase.co/rest/v1/`, ASK, 'host label that only ends with the staging ref'],
  [`curl https://${STAGING}x.supabase.co/rest/v1/`, ASK, 'host label that only starts with the staging ref'],
  [`curl https://${STAGING}.supabase.co${String.fromCharCode(64)}${OTHER}.supabase.co/rest/v1/`, ASK, 'the staging host is only the user part; the real host is another project'],
  [`curl "https://${STAGING}.supabase.co$SUPABASE_SUFFIX/rest/v1/"`, ASK, 'the host continues into a variable'],
  [`curl "$SUPABASE_URL/rest/v1/?ref=${STAGING}"`, ASK, 'host from a variable, staging only in the query'],
  [`curl https://${STAGING}.supabase.co/rest/v1/ "https://${OTHER}.supabase.co/rest/v1/?ref=${STAGING}"`, ASK, 'a staging URL does not excuse the second URL'],
  [`curl -H "x-ref: ${STAGING}" https://${OTHER}.supabase.co/rest/v1/`, ASK, 'the staging ref is in a header, not the URL'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// Ruling (c) - rule 6: --project-ref naming a project other than staging
// ---------------------------------------------------------------------------

table('ruling (c): --project-ref naming a project other than staging asks, whatever is linked', [
  [`supabase db push --project-ref ${OTHER}`, ASK, 'another project, space form'],
  [`supabase db push --project-ref=${OTHER}`, ASK, 'another project, = form'],
  [`supabase db push --project-ref "${OTHER}"`, ASK, 'another project, quoted'],
  [`supabase --project-ref ${OTHER} db push`, ASK, 'the flag before the subcommand'],
  [`supabase secrets list --project-ref ${OTHER}`, ASK, 'a read of another project'],
  [`supabase functions deploy report --project-ref ${OTHER}`, ASK, 'a deploy to another project'],
  ['supabase db push --project-ref "$PROJECT_REF"', ASK, 'a ref held in a variable'],
  ['supabase db push --project-ref=$PROJECT_REF', ASK, 'a ref held in a variable, = form'],
  ['supabase db push --project-ref', ASK, 'the flag with no value'],
  [`supabase db push --project-ref ${STAGING}x`, ASK, 'a ref that only starts with the staging ref'],
  [`supabase db push --project-ref x${STAGING}`, ASK, 'a ref that only ends with the staging ref'],
  [`supabase db push --project-ref ${STAGING} --project-ref ${OTHER}`, ASK, 'staging first, another project second'],
  [`supabase db push --project-ref ${OTHER} --project-ref ${STAGING}`, ASK, 'another project first, staging second'],
  [`npx supabase db push --project-ref ${OTHER}`, ASK, 'through npx'],
  [`bash -c "supabase db push --project-ref ${OTHER}"`, ASK, 'bash -c string'],
  [`cd supabase && supabase db push --project-ref ${OTHER}`, ASK, 'after cd'],
  [`supabase db push --linked --project-ref ${OTHER}`, ASK, '--linked does not win over a named project'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// Ruling (d) - command wrappers are looked through
// ---------------------------------------------------------------------------

table('ruling (d): a wrapper does not hide a push to main, a force-push or a merge', [
  ['env git push origin main', DENY, 'env'],
  ['env GIT_TRACE=1 git push origin main', DENY, 'env with an assignment'],
  ['env -i git push origin main', DENY, 'env with a flag'],
  ['env -u GIT_DIR git push origin main', DENY, 'env with a flag that takes a value'],
  ['/usr/bin/env git push origin main', DENY, 'env by path'],
  ['time git push origin main', DENY, 'time'],
  ['time -p git push origin main', DENY, 'time with a flag'],
  ['nohup git push origin main &', DENY, 'nohup, in the background'],
  ['command git push origin main', DENY, 'command'],
  ['command -p git push origin main', DENY, 'command with a flag'],
  ['sudo git push origin main', DENY, 'sudo'],
  ['sudo -u someone git push origin main', DENY, 'sudo with a flag that takes a value'],
  ['sudo -E GIT_TRACE=1 git push origin main', DENY, 'sudo with an assignment'],
  ['echo origin | xargs git push --force', DENY, 'xargs'],
  ['echo x | xargs -I{} git push origin main', DENY, 'xargs with -I'],
  ['echo x | xargs -n 1 sh -c "git push origin main"', DENY, 'xargs running a shell string'],
  ['exec git push origin main', DENY, 'exec'],
  ['exec -a renamed git push origin main', DENY, 'exec with a flag that takes a value'],
  ['nice git push origin main', DENY, 'nice'],
  ['nice -n 5 git push origin main', DENY, 'nice with an adjustment'],
  ['timeout 30 git push origin main', DENY, 'timeout'],
  ['timeout -s KILL 30 git push origin main', DENY, 'timeout with a signal'],
  ['timeout --kill-after=5 30 git push --force origin feature', DENY, 'timeout with a long flag'],
  ['npx -c "git push origin main"', DENY, 'npx -c string'],
  ['npm exec -c "git push origin main"', DENY, 'npm exec -c string'],
  ['npx gh pr merge 3', DENY, 'npx'],
  ['bunx gh pr merge 3', DENY, 'bunx'],
  ['pnpx gh pr merge 3', DENY, 'pnpx'],
  ['npm exec gh pr merge 3', DENY, 'npm exec'],
  ['npm exec -- gh pr merge 3', DENY, 'npm exec --'],
  ['env time nohup git push origin main', DENY, 'wrappers stacked'],
  ['sudo env GIT_TRACE=1 nice timeout 30 gh pr merge 3 --squash', DENY, 'wrappers stacked with flags'],
  ['env bash -c "git push origin main"', DENY, 'a wrapper around a shell string'],
  ['time gh api -X PUT repos/owner/repo/pulls/5/merge', DENY, 'a wrapper around a REST merge'],
], STRICT_AND_PERMISSIVE);

table('ruling (d): a wrapper does not hide a call that asks', [
  ['env SUPABASE_ACCESS_TOKEN=x supabase db push', ASK, 'env: supabase CLI'],
  ['time supabase db push', ASK, 'time: supabase CLI'],
  ['nohup supabase db push &', ASK, 'nohup: supabase CLI'],
  ['command supabase db push', ASK, 'command: supabase CLI'],
  ['sudo supabase db push', ASK, 'sudo: supabase CLI'],
  ['echo y | xargs supabase db reset --linked', ASK, 'xargs: supabase CLI'],
  ['exec supabase db push', ASK, 'exec: supabase CLI'],
  ['nice supabase db push', ASK, 'nice: supabase CLI'],
  ['timeout 60 supabase db push', ASK, 'timeout: supabase CLI'],
  ['npx supabase db push', ASK, 'npx: supabase CLI'],
  ['bunx supabase db push', ASK, 'bunx: supabase CLI'],
  ['pnpx supabase db push', ASK, 'pnpx: supabase CLI'],
  ['npm exec supabase db push', ASK, 'npm exec: supabase CLI'],
  ['npm exec -- supabase db push', ASK, 'npm exec --: supabase CLI'],
  ['npx --yes --package=supabase -- supabase db push', ASK, 'npx with --package and --'],
  ['env psql "$DATABASE_URL"', ASK, 'env: psql'],
  ['time psql -h db.example.com -U postgres', ASK, 'time: psql'],
  ['timeout 30 pg_dump "$DATABASE_URL"', ASK, 'timeout: pg_dump'],
  ['nohup curl "$SUPABASE_URL/rest/v1/" &', ASK, 'nohup: curl with a SUPABASE variable'],
  ['echo id | xargs -I{} curl https://api.supabase.com/v1/projects/{}', ASK, 'xargs: curl to the management API'],
  ['env X=1 scripts/create-user.sh a@example.com', ASK, 'env: management script'],
  ['time bash scripts/create-user.sh a@example.com', ASK, 'time: management script through bash'],
  ['sudo scripts/delete-test-data.sh', ASK, 'sudo: management script'],
  ['echo a | xargs scripts/delete-test-data.sh', ASK, 'xargs: management script'],
  ['exec scripts/check-attribution.sh', ASK, 'exec: management script'],
  ['nohup python3 e2e/rls_e2e.py &', ASK, 'nohup: e2e suite'],
  ['command python3 e2e/rls_e2e.py', ASK, 'command: e2e suite'],
  ['nice python3 e2e/rls_e2e.py', ASK, 'nice: e2e suite'],
  ['timeout 600 python3 e2e/rls_e2e.py', ASK, 'timeout: e2e suite'],
  ['timeout 5 npm run test:rls', ASK, 'timeout: test:* script'],
  ['env CI=1 npm run test:rls', ASK, 'env: test:* script'],
  ['time npm run test:e2e', ASK, 'time: test:* script'],
  ['npx npm run test:rls', ASK, 'npx: test:* script'],
], ['none', 'prodLinked']);

table('ruling (d): a wrapper around an ordinary command stays allowed', [
  ['time npm test', ALLOW, 'time'],
  ['env CI=1 npm run build', ALLOW, 'env'],
  ['env | grep -c SUPABASE', ALLOW, 'env with no command'],
  ['nohup npm run build &', ALLOW, 'nohup'],
  ['command -v jq', ALLOW, 'command -v is a lookup'],
  ['command -v git push origin main', ALLOW, 'command -v runs nothing'],
  ['timeout 600 node --test "scripts/**/*.test.mjs"', ALLOW, 'timeout'],
  ['nice npm run lint', ALLOW, 'nice'],
  ['exec 3>&1', ALLOW, 'exec with only a redirection'],
  ['npx tsc --noEmit', ALLOW, 'npx'],
  ['ls scripts | xargs -n 1 echo', ALLOW, 'xargs'],
  ['git ls-files | xargs grep -l "git push origin main"', ALLOW, 'rule 4: xargs around grep, the phrase is a pattern'],
  ['env LC_ALL=C grep -rn "gh pr merge" docs/', ALLOW, 'rule 4: env around grep, the phrase is a pattern'],
  ['time git push -u origin some-feature-branch', ALLOW, 'time around a feature-branch push'],
], STRICT_AND_PERMISSIVE);

// ---------------------------------------------------------------------------
// Ruling (e) - missing guard.conf or empty PROD_REF: exit 2
// ---------------------------------------------------------------------------

describe('ruling (e): a missing guard.conf or an empty PROD_REF fails closed (exit 2)', () => {
  /** A project directory whose guard.conf holds `conf`; null = no file at all. */
  function projectWithConf(conf) {
    const dir = mkdtempSync(join(tmpdir(), 'guard-bash-conf-'));
    TEMP_DIRS.push(dir);
    mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
    if (conf !== null) writeFileSync(join(dir, 'scripts', 'hooks', 'guard.conf'), conf);
    return dir;
  }
  const broken = [
    ['no guard.conf', () => projectWithConf(null)],
    ['an empty guard.conf', () => projectWithConf('')],
    ['PROD_REF= with nothing after it', () => projectWithConf(`PROD_REF=\nSTAGING_REF=${STAGING}\n`)],
    ['PROD_REF set to an empty quoted string', () => projectWithConf('PROD_REF=""\nSTAGING_REF=\n')],
    ['PROD_REF set to blanks', () => projectWithConf('PROD_REF=   \nSTAGING_REF=\n')],
    ['only STAGING_REF is set', () => projectWithConf(`STAGING_REF=${STAGING}\n`)],
    ['PROD_REF only inside a comment', () => projectWithConf(`# PROD_REF=${PROD}\nSTAGING_REF=\n`)],
    ['guard.conf is a directory', () => {
      const dir = projectWithConf(null);
      mkdirSync(join(dir, 'scripts', 'hooks', 'guard.conf'));
      return dir;
    }],
    ['CLAUDE_PROJECT_DIR does not exist', () => join(tmpdir(), `guard-bash-missing-${process.pid}`)],
  ];
  const commands = [
    ['git status', 'an ordinary command'],
    [`echo ${PROD}`, 'a command naming what would be production'],
    ['supabase db push', 'a remote supabase call'],
    ['git push origin main', 'a push to main'],
  ];
  for (const [why, build] of broken) {
    for (const [command, what] of commands) {
      it(`exit 2: ${why} - ${what} (${command})`, () => {
        const result = runCommand(command, build());
        assert.equal(result.status, 2, `expected exit 2, got ${decisionOf(result)}`);
        assert.notEqual(result.stderr.trim(), '', 'expected a message on stderr');
      });
    }
  }

  it('a guard.conf with PROD_REF set and STAGING_REF absent works: nothing is staging', () => {
    const dir = projectWithConf(`PROD_REF=${PROD}\n`);
    assert.equal(decisionOf(runCommand('git status', dir)), ALLOW);
    assert.equal(decisionOf(runCommand(`echo ${PROD}`, dir)), ASK);
    assert.equal(decisionOf(runCommand('supabase db push', dir)), ASK);
  });

  it('a quoted PROD_REF and Windows line endings are still read', () => {
    const dir = projectWithConf(`PROD_REF="${PROD}"\r\nSTAGING_REF=\r\n`);
    assert.equal(decisionOf(runCommand(`echo ${PROD}`, dir)), ASK);
    assert.equal(decisionOf(runCommand('git status', dir)), ALLOW);
  });
});

// ---------------------------------------------------------------------------
// Validation: what the workflow runs all day must stay allowed
// ---------------------------------------------------------------------------

table('validation: the commands the workflow needs constantly stay allowed', [
  ['git add -A', ALLOW, 'stage'],
  ['git add scripts/hooks/guard-bash.test.mjs && git commit -m "WF-4: validation tests"', ALLOW, 'stage and commit'],
  ['git status --porcelain', ALLOW, 'status'],
  ['git diff main...HEAD --stat', ALLOW, 'diff against main'],
  ['git log main..HEAD --oneline', ALLOW, 'log against main'],
  ['git fetch origin main', ALLOW, 'fetch main'],
  ['git checkout main', ALLOW, 'switch to main locally'],
  ['git rebase origin/main', ALLOW, 'rebase on main'],
  ['git merge main', ALLOW, 'merge main into the feature branch locally'],
  ['git push -u origin chore/agent-workflow', ALLOW, 'push the feature branch'],
  ['git push -u origin chore/agent-workflow 2>&1 | tail -5', ALLOW, 'push with the output trimmed'],
  ['git push -u origin "$(git branch --show-current)"', ALLOW, 'push the current branch by name'],
  ['git push -u origin HEAD', ALLOW, 'push the current branch by HEAD'],
  ['gh pr create --base main --head chore/agent-workflow --title "WF-4" --body "$(cat <<\'EOF\'\nMerge into main after review; git push origin main stays denied.\nEOF\n)"', ALLOW, 'open a pull request against main with a here-document body'],
  ['gh pr view 3 --json state,mergeable,mergeStateStatus', ALLOW, 'read whether a pull request can merge'],
  ['gh pr checks 3 --watch', ALLOW, 'watch checks'],
  ['gh pr list --search "merge"', ALLOW, 'search pull requests'],
  ['gh run list --limit 5', ALLOW, 'list CI runs'],
  ['gh run view 123 --log-failed', ALLOW, 'read a CI run'],
  ['gh run watch 123 --exit-status', ALLOW, 'watch a CI run'],
  ['npm ci', ALLOW, 'install'],
  ['npm test --silent', ALLOW, 'unit tests'],
  ['npm run --silent lint', ALLOW, 'type check'],
  ['npm run build', ALLOW, 'build'],
  ['node --test --test-reporter=tap "scripts/**/*.test.mjs" 2>&1 | tail -20', ALLOW, 'script tests'],
  ['scripts/gate.sh', ALLOW, 'the gate, default mode'],
  ['bash scripts/gate.sh full', ALLOW, 'the gate through bash'],
  ['scripts/check-scope.sh snapshot > /tmp/before.txt', ALLOW, 'scope snapshot'],
  ["scripts/check-scope.sh developer /tmp/before.txt --allow 'scripts/hooks/**' --allow package.json", ALLOW, 'scope check with --allow'],
  ['python3 scripts/tool.py', ALLOW, 'a Python script outside e2e/'],
  ['python3 /tmp/scratch/probe.py', ALLOW, 'a scratch Python script'],
  ["python3 - <<'EOF'\nprint('git push origin main')\nEOF", ALLOW, 'inline Python from a here-document; the phrase is data'],
  ['python3 -m json.tool package.json', ALLOW, 'a standard-library module'],
  ['jq .scripts package.json', ALLOW, 'jq'],
  ['ls -la', ALLOW, 'ls'],
  ['cat e2e/rls_e2e.py', ALLOW, 'cat an e2e file'],
  ["sed -n '1,40p' scripts/create-user.sh", ALLOW, 'sed over a management script'],
  ["sed -n '1,40p' e2e/rls_e2e.py", ALLOW, 'sed over an e2e file'],
  ['grep -rn "supabase db push" docs', ALLOW, 'grep for a guarded command'],
  ['grep -n SUPABASE e2e/*.py', ALLOW, 'grep in e2e/'],
  ['find . -name "*.sh" -not -path "./node_modules/*"', ALLOW, 'find'],
  ['find e2e -name "*.py" -exec wc -l {} +', ALLOW, 'find -exec with a harmless command'],
  ['find . -name "*.sh" -exec bash -n {} \\;', ALLOW, 'find -exec bash -n'],
  ['echo "$SUPABASE_URL"', ALLOW, 'printing a SUPABASE variable'],
  ['curl -s https://api.github.com/repos/owner/repo/pulls', ALLOW, 'reading the GitHub API with curl'],
  ['x=$((1<<2)); echo $x', ALLOW, 'an arithmetic shift'],
  ['git commit -m "deny \\`git push origin main\\`"', ALLOW, 'a commit message with escaped backticks'],
  ["git commit -F - <<'EOF'\ngh pr merge is denied\nEOF", ALLOW, 'a commit message from a quoted here-document'],
], STRICT_AND_PERMISSIVE);

describe('validation: input built to exhaust the analyser never comes back as allow', () => {
  const hostile = [
    ['3000 nested subshells around a push to main', `${'('.repeat(3000)}git push origin main${')'.repeat(3000)}`],
    ['2000 nested command substitutions around a push to main', `echo ${'$('.repeat(2000)}git push origin main${')'.repeat(2000)}`],
    ['14 nested bash -c strings around a merge', Array.from({ length: 14 }).reduce((inner) => `bash -c ${JSON.stringify(inner)}`, 'gh pr merge 3')],
    ['a 400 000-character line ending in a push to main', `echo ${'a '.repeat(200000)}; git push origin main`],
  ];
  for (const [why, command] of hostile) {
    it(`not allow: ${why}`, () => {
      const got = decisionOf(runCommand(command));
      assert.ok(got === DENY || got === ASK || got === 'exit 2', `expected deny, ask or exit 2, got: ${got}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Validation: weaknesses found. Each block below is red until the hook is
// changed (or the Lead rules the behaviour acceptable).
// ---------------------------------------------------------------------------

// The parser treats the "<<" of an arithmetic shift as a here-document
// operator and swallows the following lines as its body, so the commands on
// those lines are never analysed. Criteria: "analyses each simple command of
// the line (split on ... newlines ...)".
table('validation: an arithmetic shift is not a here-document, so the next line is still analysed', [
  ['echo $((1<<2))\ngit push origin main', DENY, 'a push to main on the line after a shift'],
  ['n=$((1<<4))\ngit push --force origin feature', DENY, 'a force-push on the line after a shift in an assignment'],
  [': $((1<<9))\ngh pr merge 3\n9', DENY, 'a merge between a shift and a line equal to its right operand'],
  ['echo $((1<<2))\nsupabase db push', { none: ASK, prodLinked: ASK }, 'a remote supabase call on the line after a shift'],
  ['echo $((1<<2))\nnpm run test:rls', { none: ASK, prodLinked: ASK }, 'a test:* script on the line after a shift'],
]);

// Text handed to a shell on standard input. The implementation reads a
// here-document only when the shell has no other argument; the header lists
// "text piped or redirected into a shell" as a known limit.
table('validation: a shell that reads its commands from standard input is looked into', [
  ['bash <<< "git push origin main"', DENY, 'a here-string'],
  ['bash -s -- arg <<EOF\ngit push origin main\nEOF', DENY, 'bash -s with arguments and a here-document'],
  ['bash /dev/stdin <<EOF\ngit push origin main\nEOF', DENY, 'bash /dev/stdin with a here-document'],
  ['bash < scripts/create-user.sh', ASK, 'a management script redirected into bash'],
]);

// Refspecs that include main without naming it; the criteria name --all and
// --mirror, and these are the refspec spellings of the same thing.
table('validation: a wildcard or matching refspec pushes main too', [
  ['git push origin "refs/heads/*:refs/heads/*"', DENY, 'every branch, by wildcard'],
  ["git push origin ':'", DENY, 'the matching refspec: every branch that exists on both sides'],
]);

table('validation: other git commands that publish to main', [
  ['git subtree push --prefix docs origin main', DENY, 'git subtree push'],
  ['git -c remote.origin.push=HEAD:main push origin', DENY, 'the destination given as configuration on the command line'],
]);

table('validation: the body of a shell function is analysed', [
  ['function publish { git push origin main; }; publish', DENY, 'function keyword form'],
]);

// Wrappers that are not in the Lead's list (ruling d) but run their argument
// the same way.
table('validation: wrappers outside the listed set', [
  ['caffeinate -i git push origin main', DENY, 'caffeinate (macOS: keep awake while a command runs)'],
  ['stdbuf -oL git push origin main', DENY, 'stdbuf'],
  ['noglob git push origin main', DENY, 'noglob (zsh precommand modifier; the Bash tool runs zsh on this machine)'],
  ['dotenv -- supabase db push', { none: ASK, prodLinked: ASK }, 'dotenv-cli in front of the supabase CLI'],
  ['corepack pnpm run test:rls', { none: ASK, prodLinked: ASK }, 'corepack in front of a package manager'],
]);

// The criteria name `gh pr merge`, `gh api` on /merge and /protection, and
// GraphQL mergePullRequest. These reach the same outcome another way.
table('validation: other ways to change main or its protection over the GitHub API', [
  ['gh api -X PATCH repos/owner/repo/git/refs/heads/main -f sha=abc123 -F force=true', DENY, 'moving the main ref directly, forced'],
  ['gh api -X POST repos/owner/repo/rulesets --input ruleset.json', DENY, 'repository rulesets are branch protection under another path'],
  ['gh api -X DELETE repos/owner/repo/rulesets/5', DENY, 'deleting a ruleset'],
  ['curl -X PUT -H "Authorization: token $GH_TOKEN" https://api.github.com/repos/owner/repo/pulls/5/merge', DENY, 'the REST merge with curl instead of gh'],
]);

// Opposite direction: a read is denied.
table('validation: a read-only GraphQL query that mentions branch protection is not a change', [
  ["gh api graphql -f query='{ repository(owner:\"o\", name:\"r\") { branchProtectionRules(first: 5) { nodes { pattern } } } }'", ALLOW, 'reads the protection rules; no mutation'],
]);

// Rule 9: "any Python file under e2e/". The header lists the value of a
// variable as a known limit; these are the ordinary ways to run every suite.
// Changed for RF-048 (P0-6): these rows asked under prodLinked and under
// stagingLinked. They are e2e runs, so they now follow the e2e rule: ask
// while STAGING_REF is empty, allowed once it is set.
//
// Changed for RF-053 (P0-9): the first four rows were STAGING_SET (allowed
// once STAGING_REF is set). The criterion now reads "Python reading its
// program from stdin, or given a dynamic script argument, asks again": the
// guard cannot show that such a run resolves to this project's own e2e/
// folder, so these ask in every configuration. The xargs and find rows are
// the Test Engineer's reading of "a dynamic script argument" (the argument
// comes from another command's output).
table('validation: e2e suites reached without naming the file on the interpreter line', [
  ['for f in e2e/*.py; do python3 "$f"; done', ASK_EVERYWHERE, 'RF-053: a loop over e2e/*.py - the script argument is a variable'],
  ['ls e2e/*.py | xargs -n1 python3', ASK_EVERYWHERE, 'RF-053: xargs over e2e/*.py - the script argument comes from a pipe'],
  ['find e2e -name "*_e2e.py" -exec python3 {} \\;', ASK_EVERYWHERE, 'RF-053: find -exec python3 - the script argument is filled in by find'],
  ['python3 < e2e/rls_e2e.py', ASK_EVERYWHERE, 'RF-053: the program is read from standard input'],
  ['python3 -m unittest discover -s e2e', STAGING_SET, 'unittest discovery imports every file under e2e/'],
  ['env -C e2e python3 rls_e2e.py', STAGING_SET, 'env -C changes directory first'],
  ['uv run e2e/rls_e2e.py', STAGING_SET, 'another runner'],
]);

// Rule 9: "any test:* package script with any runner".
// Changed for RF-048 (P0-6): asked under prodLinked and stagingLinked; now
// follows the test:* rule.
table('validation: a test:* script reached another way', [
  ['npm run -- test:rls', STAGING_SET, 'npm accepts the script name after --'],
  ['npx npm-run-all "test:*"', STAGING_SET, 'npm-run-all with a pattern'],
]);

// Ruling (b): curl removes dot segments before sending, so this request goes
// to the OTHER project.
table('validation: dot segments after the staging project segment', [
  [`curl https://api.supabase.com/v1/projects/${STAGING}/../${OTHER}/database/query -d @query.json`, ASK, 'the path resolves to another project'],
], ['stagingLinked', 'stagingSetNoLink']);

describe('validation: a comment after PROD_REF in guard.conf does not switch the production check off', () => {
  // guard.conf says "'#' starts a comment". With a trailing comment the value
  // becomes "<ref> # ...", which no command line contains, so rule 5 never
  // fires and nothing reports it.
  for (const conf of [`PROD_REF=${PROD} # production\nSTAGING_REF=\n`, `PROD_REF=${PROD}\t# production\nSTAGING_REF=\n`]) {
    it(`ask or exit 2: ${JSON.stringify(conf)}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'guard-bash-conf-'));
      TEMP_DIRS.push(dir);
      mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'hooks', 'guard.conf'), conf);
      const got = decisionOf(runCommand(`echo ${PROD}`, dir));
      assert.ok(got === ASK || got === 'exit 2', `the production ref was named and the hook said: ${got}`);
    });
  }
});

// ===========================================================================
// P0-6 (written before implementation): RF-043, RF-045, RF-048 and the e2e
// self-test. Requirement: "P0-6 acceptance criteria" in
// docs/saas/IMPLEMENTATION_STATUS.md. Existing rows that these criteria
// changed are marked "Changed for RF-0xx (P0-6)" where they stand above.
// ===========================================================================

// ---------------------------------------------------------------------------
// RF-043 - a non-local `supabase db reset` asks, also when staging is linked
// ---------------------------------------------------------------------------

table('P0-6 RF-043: a non-local supabase db reset asks in every configuration', [
  ['supabase db reset', ASK_EVERYWHERE, 'no --local: not provably local'],
  ['supabase db reset --linked', ASK_EVERYWHERE, 'the linked project'],
  ['supabase db reset --linked --yes', ASK_EVERYWHERE, 'confirmed in advance'],
  ['supabase db reset --linked --no-seed', ASK_EVERYWHERE, 'with another flag'],
  ['supabase db reset --version 20260101000000 --linked', ASK_EVERYWHERE, 'to a migration version'],
  [`supabase db reset --linked --project-ref ${STAGING}`, ASK_EVERYWHERE, 'naming staging does not excuse a reset'],
  [`supabase db reset --project-ref ${STAGING}`, ASK_EVERYWHERE, 'naming staging does not excuse a reset'],
  [`supabase --project-ref ${STAGING} db reset`, ASK_EVERYWHERE, 'the staging ref before the subcommand'],
  ['supabase db reset --db-url "$DATABASE_URL"', ASK_EVERYWHERE, 'an explicit target in a variable'],
  ['supabase --debug db reset --linked', ASK_EVERYWHERE, 'global flag before the verb'],
  ['supabase --workdir . db reset --linked', ASK_EVERYWHERE, 'global flag with a value'],
  ['npx supabase db reset --linked', ASK_EVERYWHERE, 'through npx'],
  ['./node_modules/.bin/supabase db reset --linked', ASK_EVERYWHERE, 'by path'],
  ['cd supabase && supabase db reset --linked', ASK_EVERYWHERE, 'cd then run'],
  ['bash -c "supabase db reset --linked"', ASK_EVERYWHERE, 'bash -c string'],
  ['eval "supabase db reset --linked"', ASK_EVERYWHERE, 'eval string'],
  ['(supabase db reset --linked)', ASK_EVERYWHERE, 'subshell'],
  ['time supabase db reset --linked', ASK_EVERYWHERE, 'a wrapper'],
  ['echo y | xargs supabase db reset --linked', ASK_EVERYWHERE, 'xargs'],
  ['supabase db reset --linked # --local', ASK_EVERYWHERE, 'a --local inside a comment does not count'],
  ['supabase db reset --linked; echo --local', ASK_EVERYWHERE, 'the --local belongs to another command'],
  ['supabase db reset --locale', ASK_EVERYWHERE, '--locale is not --local'],
  ['supabase db reset --local && supabase db reset --linked', ASK_EVERYWHERE, 'a local reset does not excuse the remote one'],
  ['supabase db push && supabase db reset --linked', ASK_EVERYWHERE, 'after a call that staging would allow'],
]);

table('P0-6 RF-043: what the reset rule leaves alone', [
  ['supabase db reset --local', ALLOW, 'a local reset stays allowed'],
  ['supabase --local db reset', ALLOW, '--local before the subcommand'],
  ['npx supabase db reset --local', ALLOW, 'a local reset through npx'],
  ['supabase db reset --help', ALLOW, '--help runs nothing'],
  ['git commit -m "supabase db reset --linked now asks"', ALLOW, 'rule 4: a mention'],
  ['grep -rn "supabase db reset" docs/', ALLOW, 'rule 4: a grep pattern'],
], ALL_CONFIGS);

table('P0-6 RF-043: other destructive-looking calls keep their staging allowance (only db reset changed)', [
  ['supabase migration repair --status applied 20260101000000', LINK_DECIDES, 'migration repair is left as it is'],
  ['supabase migration repair --status reverted 20260101000000', LINK_DECIDES, 'migration repair is left as it is'],
  ['supabase db push', LINK_DECIDES, 'db push still follows the link'],
  ['supabase db push --include-all', LINK_DECIDES, 'db push still follows the link'],
]);

// ---------------------------------------------------------------------------
// RF-043 - the management API for the staging project
// ---------------------------------------------------------------------------

const MGMT = `https://api.supabase.com/v1/projects/${STAGING}`;

table('P0-6 RF-043: a management API request for the staging project is allowed once STAGING_REF is set', [
  [`curl ${MGMT}`, NAMES_STAGING, 'GET on the project itself'],
  [`curl -X GET ${MGMT}`, NAMES_STAGING, 'explicit GET on the project itself'],
  [`curl -X GET ${MGMT}/branches`, NAMES_STAGING, 'GET on a sub-path'],
  [`curl -s ${MGMT}/api-keys`, NAMES_STAGING, 'GET on a sub-path'],
  [`curl -X POST ${MGMT}/database/query -d @query.json`, NAMES_STAGING, 'POST on a sub-path'],
  [`curl --request POST "${MGMT}/database/query" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -d @query.json`, NAMES_STAGING, 'POST with --request and a token header'],
  [`curl -d @query.json ${MGMT}/database/query`, NAMES_STAGING, 'POST implied by a body'],
  [`curl -X PATCH ${MGMT}/config/auth -d @auth.json`, NAMES_STAGING, 'PATCH on a sub-path'],
  [`curl -XPATCH ${MGMT}/postgrest -d @rest.json`, NAMES_STAGING, 'PATCH joined to the flag'],
  [`curl ${MGMT}/config/auth -X PATCH -d @auth.json`, NAMES_STAGING, 'method after the URL'],
  [`curl -X PUT ${MGMT}/config/database/postgres -d @pg.json`, NAMES_STAGING, 'PUT on a sub-path'],
]);

table('P0-6 RF-043: DELETE on the staging project itself asks in every configuration', [
  [`curl -X DELETE ${MGMT}`, ASK_EVERYWHERE, '-X DELETE'],
  [`curl -XDELETE ${MGMT}`, ASK_EVERYWHERE, '-XDELETE joined'],
  [`curl --request DELETE ${MGMT}`, ASK_EVERYWHERE, '--request DELETE'],
  [`curl -X delete ${MGMT}`, ASK_EVERYWHERE, 'lower-case method'],
  [`curl ${MGMT} -X DELETE`, ASK_EVERYWHERE, 'method after the URL'],
  [`curl -X DELETE "${MGMT}"`, ASK_EVERYWHERE, 'quoted URL'],
  [`curl -X "DELETE" ${MGMT}`, ASK_EVERYWHERE, 'quoted method'],
  [`curl -X DELETE ${MGMT}/`, ASK_EVERYWHERE, 'trailing slash'],
  [`curl -X DELETE "${MGMT}?confirm=true"`, ASK_EVERYWHERE, 'a query string after the project'],
  [`curl -X DELETE --url ${MGMT}`, ASK_EVERYWHERE, 'given with --url'],
  [`curl -s -H "Authorization: Bearer $TOKEN" -X DELETE ${MGMT}`, ASK_EVERYWHERE, 'flags before the method'],
  [`wget --method=DELETE ${MGMT}`, ASK_EVERYWHERE, 'wget --method=DELETE'],
  [`wget --method DELETE ${MGMT}`, ASK_EVERYWHERE, 'wget --method DELETE'],
  [`bash -c "curl -X DELETE ${MGMT}"`, ASK_EVERYWHERE, 'bash -c string'],
  [`time curl -X DELETE ${MGMT}`, ASK_EVERYWHERE, 'a wrapper'],
  [`curl -X GET ${MGMT}/branches && curl -X DELETE ${MGMT}`, ASK_EVERYWHERE, 'an allowed request does not excuse the delete'],
  [`curl -X GET ${MGMT}/branches -: -X DELETE ${MGMT}`, ASK_EVERYWHERE, 'the second request of one curl call (--next)'],
]);

table('P0-6 RF-043 (assumed reading): the exception is DELETE on the project itself and nothing else', [
  [`curl -X DELETE ${MGMT}/branches/feature-x`, NAMES_STAGING, 'B1: DELETE on a sub-path is not the project itself'],
  [`curl -X PATCH ${MGMT} -d @project.json`, NAMES_STAGING, 'B1: PATCH on the project itself is not a DELETE'],
  [`curl -X "$METHOD" ${MGMT}`, ASK_EVERYWHERE, 'B2: a method held in a variable is not provably something other than DELETE'],
  [`curl -X DELETE ${MGMT}/branches/..`, ASK_EVERYWHERE, 'B3: dot segments resolve to the project itself'],
]);

table('P0-6 RF-043: the management API for any other project still asks', [
  [`curl -X POST https://api.supabase.com/v1/projects/${OTHER}/database/query -d @query.json`, ASK, 'another project'],
  [`curl -X DELETE https://api.supabase.com/v1/projects/${OTHER}`, ASK, 'deleting another project'],
  ['curl -X POST https://api.supabase.com/v1/projects -d @project.json', ASK, 'creating a project'],
  ['curl -X DELETE "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF"', ASK, 'a project held in a variable'],
  [`curl -X DELETE https://api.supabase.com/v1/projects/${PROD}`, ASK, 'production: rule 5'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// RF-045 - python -m unittest / -m pytest aimed at e2e is an e2e run
// ---------------------------------------------------------------------------

table('P0-6 RF-045: python -m unittest or -m pytest with an argument whose first dotted part is e2e is an e2e run', [
  ['python3 -m unittest e2e.rls_e2e', STAGING_SET, 'the finding: a module under e2e'],
  ['python -m pytest e2e', STAGING_SET, 'pytest over the e2e package'],
  ['python3 -m unittest e2e.saas.tenant_isolation_e2e', STAGING_SET, 'a nested module'],
  ['python3 -m unittest e2e', STAGING_SET, 'the package itself'],
  ['python -m unittest e2e.rls_e2e', STAGING_SET, 'python instead of python3'],
  ['python3 -m unittest -v e2e.rls_e2e', STAGING_SET, 'a flag before the module'],
  ['python3 -m unittest e2e.rls_e2e -v', STAGING_SET, 'a flag after the module'],
  ['python3 -m unittest scripts.something e2e.rls_e2e', STAGING_SET, 'any argument: the second one is e2e'],
  ['python3 -m unittest e2e.rls_e2e.RlsTests.test_read', STAGING_SET, 'a single test inside an e2e module'],
  ['python3 -m pytest -q e2e', STAGING_SET, 'pytest with a flag'],
  ['python3 -m pytest e2e.rls_e2e', STAGING_SET, 'pytest with a dotted name'],
  ['python3 -u -m unittest e2e.rls_e2e', STAGING_SET, 'an interpreter flag before -m'],
  ['python3 -m unittest "e2e.rls_e2e"', STAGING_SET, 'quoted module'],
  ['bash -c "python3 -m unittest e2e.rls_e2e"', STAGING_SET, 'bash -c string'],
  ['timeout 600 python3 -m unittest e2e.rls_e2e', STAGING_SET, 'a wrapper'],
  ['npm test && python3 -m unittest e2e.rls_e2e', STAGING_SET, 'after &&'],
  ['DRILL_E2E_TARGET=staging python3 -m unittest e2e.rls_e2e', STAGING_SET, 'RF-010: the variable is not what decides'],
]);

table('P0-6 RF-045: unittest and pytest runs that are not aimed at e2e are unaffected', [
  ['python3 -m unittest scripts.something', ALLOW, 'a module outside e2e'],
  ['python3 -m unittest', ALLOW, 'no argument'],
  ['python3 -m unittest -v scripts.something', ALLOW, 'a flag and a module outside e2e'],
  ['python3 -m unittest discover -s scripts', ALLOW, 'discovery outside e2e'],
  ['python3 -m pytest scripts', ALLOW, 'pytest outside e2e'],
  ['python3 -m unittest e2e_helpers.checks', ALLOW, 'the first dotted part only starts with e2e'],
  ['python3 -m unittest scripts.e2e_like', ALLOW, 'e2e is not the first dotted part'],
  ['python3 -m json.tool package.json', ALLOW, 'another standard-library module'],
  ['git commit -m "python3 -m unittest e2e.rls_e2e is an e2e run"', ALLOW, 'rule 4: a mention'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// RF-048 - the management scripts
//
// "A management script asks when --production appears in the call or
// SUPABASE_PROJECT_REF is not a literal equal to the staging ref on the same
// line; otherwise it is allowed." The scripts have no default project
// (P0-3 criterion 7), so a call that does not set the variable itself takes
// it from an environment the guard cannot see.
// ---------------------------------------------------------------------------

table('P0-6 RF-048: a management script with SUPABASE_PROJECT_REF=<staging ref> on its line is allowed once STAGING_REF is set', [
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, NAMES_STAGING, 'prefix assignment'],
  [`SUPABASE_PROJECT_REF=${STAGING} ./scripts/delete-test-data.sh`, NAMES_STAGING, 'prefix assignment, ./ path'],
  [`SUPABASE_PROJECT_REF=${STAGING} bash scripts/check-attribution.sh`, NAMES_STAGING, 'prefix assignment, through bash'],
  [`SUPABASE_PROJECT_REF="${STAGING}" scripts/create-user.sh a@example.com`, NAMES_STAGING, 'a quoted literal is still a literal'],
  [`SUPABASE_PROJECT_REF='${STAGING}' scripts/delete-test-data.sh`, NAMES_STAGING, 'single-quoted literal'],
  [`env SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, NAMES_STAGING, 'through env'],
  [`env SUPABASE_PROJECT_REF=${STAGING} bash scripts/delete-test-data.sh`, NAMES_STAGING, 'through env and bash'],
  [`SUPABASE_ACCESS_TOKEN="$TOKEN" SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, NAMES_STAGING, 'next to another assignment'],
  [`cd scripts && SUPABASE_PROJECT_REF=${STAGING} ./create-user.sh a@example.com`, NAMES_STAGING, 'cd then run'],
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com && SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh`, NAMES_STAGING, 'two calls, each with its own assignment'],
]);

table('P0-6 RF-048: a management script asks when --production appears in the call', [
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh --production a@example.com`, ASK_EVERYWHERE, '--production as the first argument'],
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com --production`, ASK_EVERYWHERE, '--production as a later argument'],
  [`SUPABASE_PROJECT_REF=${STAGING} bash scripts/delete-test-data.sh --production`, ASK_EVERYWHERE, 'through bash'],
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/check-attribution.sh "--production"`, ASK_EVERYWHERE, 'quoted'],
  [`env SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh --production`, ASK_EVERYWHERE, 'through env'],
  [`cd scripts && SUPABASE_PROJECT_REF=${STAGING} ./delete-test-data.sh --production`, ASK_EVERYWHERE, 'cd then run'],
  [`bash -c "SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh --production"`, ASK_EVERYWHERE, 'bash -c string'],
  ['scripts/create-user.sh --production a@example.com', ASK_EVERYWHERE, 'no project given at all'],
  [`SUPABASE_PROJECT_REF=${PROD} scripts/create-user.sh --production a@example.com`, ASK_EVERYWHERE, 'production named: rule 5 as well'],
]);

table('P0-6 RF-048: a management script asks when SUPABASE_PROJECT_REF is not the literal staging ref on its line', [
  ['scripts/create-user.sh a@example.com', ASK_EVERYWHERE, 'not given: taken from the environment'],
  ['bash scripts/delete-test-data.sh', ASK_EVERYWHERE, 'not given, through bash'],
  ['scripts/check-attribution.sh', ASK_EVERYWHERE, 'not given'],
  [`SUPABASE_PROJECT_REF=${OTHER} scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'a third project'],
  [`SUPABASE_PROJECT_REF=${PROD} scripts/delete-test-data.sh`, ASK_EVERYWHERE, 'production'],
  ['SUPABASE_PROJECT_REF=$STAGING_REF scripts/create-user.sh a@example.com', ASK_EVERYWHERE, 'held in a variable: not a literal'],
  ['SUPABASE_PROJECT_REF="${REF}" scripts/delete-test-data.sh', ASK_EVERYWHERE, 'held in a braced variable'],
  ['SUPABASE_PROJECT_REF=$(cat supabase/.temp/project-ref) scripts/delete-test-data.sh', ASK_EVERYWHERE, 'from a command substitution'],
  ['SUPABASE_PROJECT_REF= scripts/create-user.sh a@example.com', ASK_EVERYWHERE, 'set to nothing'],
  [`SUPABASE_PROJECT_REF=${STAGING}x scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'only starts with the staging ref'],
  [`SUPABASE_PROJECT_REF=x${STAGING} scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'only ends with the staging ref'],
  [`SUPABASE_PROJECT_REF=${STAGING}$SUFFIX scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'the value continues into a variable'],
  [`SUPABASE_PROJECT_REF=${STAGING} SUPABASE_PROJECT_REF=${OTHER} scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'set twice: the last one wins in a shell'],
  [`MY_SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'another variable whose name ends the same'],
  [`SUPABASE_PROJECT_REF_OLD=${STAGING} scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'another variable whose name starts the same'],
  [`PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'not the variable the scripts read'],
  [`scripts/create-user.sh a@example.com SUPABASE_PROJECT_REF=${STAGING}`, ASK_EVERYWHERE, 'after the script it is an argument, not an assignment'],
  [`scripts/create-user.sh a@example.com # SUPABASE_PROJECT_REF=${STAGING}`, ASK_EVERYWHERE, 'only in a comment'],
  [`echo SUPABASE_PROJECT_REF=${STAGING} && scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'the text belongs to another command'],
  [`SUPABASE_PROJECT_REF=${STAGING} echo ready; scripts/delete-test-data.sh`, ASK_EVERYWHERE, 'the assignment belongs to another command'],
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com && scripts/delete-test-data.sh`, ASK_EVERYWHERE, 'the second call has no assignment'],
  [`env -u SUPABASE_PROJECT_REF scripts/create-user.sh a@example.com ${STAGING}`, ASK_EVERYWHERE, 'env removes the variable; the ref is only an argument'],
  ['DRILL_E2E_TARGET=staging scripts/create-user.sh a@example.com', ASK_EVERYWHERE, 'RF-010: no other variable is an escape hatch'],
  ['source scripts/create-user.sh', ASK_EVERYWHERE, 'sourced, no project given'],
  ['bash < scripts/create-user.sh', ASK_EVERYWHERE, 'redirected into a shell, no project given'],
]);

table('P0-6 RF-048: reading or staging a management script stays allowed', [
  ['cat scripts/create-user.sh', ALLOW, 'cat'],
  ['cat scripts/delete-test-data.sh scripts/check-attribution.sh', ALLOW, 'cat two of them'],
  ['git add scripts/delete-test-data.sh', ALLOW, 'git add'],
  ['git add scripts/create-user.sh scripts/check-attribution.sh', ALLOW, 'git add two of them'],
  ['git diff -- scripts/create-user.sh', ALLOW, 'git diff'],
  ['bash -n scripts/create-user.sh', ALLOW, 'bash -n only parses'],
  ['bash -n scripts/delete-test-data.sh', ALLOW, 'bash -n only parses'],
  ['sh -n scripts/check-attribution.sh', ALLOW, 'sh -n only parses'],
  ['for f in scripts/*.sh; do bash -n "$f"; done', ALLOW, 'a syntax-check loop'],
  ['grep -n -- --production scripts/create-user.sh', ALLOW, 'grep for the flag inside a management script'],
  ['wc -l scripts/create-user.sh', ALLOW, 'wc'],
], ALL_CONFIGS);

table('P0-6 RF-048: the production ref still asks whatever STAGING_REF is', [
  [`python3 e2e/rls_e2e.py ${PROD}`, ASK, 'an e2e run that names production'],
  [`npm run test:rls -- ${PROD}`, ASK, 'a test:* script that names production'],
  [`SUPABASE_PROJECT_REF=${PROD} python3 e2e/rls_e2e.py`, ASK, 'production in an assignment before an e2e run'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// The e2e self-test (P0-3 criterion 6) is allowed even while STAGING_REF is empty
// ---------------------------------------------------------------------------

table('P0-6: python3 e2e/target_selftest.py is allowed in every configuration', [
  ['python3 e2e/target_selftest.py', ALLOW, 'needs no network; the gate runs it'],
], ALL_CONFIGS);

table('P0-6: the self-test allowance covers that one file only (STAGING_REF empty)', [
  ['python3 e2e/rls_e2e.py', ASK, 'another e2e file'],
  ['python3 e2e/target_selftest_extra.py', ASK, 'a file whose name only starts the same'],
  ['python3 e2e/xtarget_selftest.py', ASK, 'a file whose name only ends the same'],
  ['python3 e2e/target_selftest.pyc.py', ASK, 'a longer name'],
  ['python3 e2e/saas/target_selftest.py', ASK, 'the same name in a subdirectory'],
  ['python3 e2e/_target.py', ASK, 'the module the self-test checks'],
  ['python3 e2e/target_selftest.py && python3 e2e/rls_e2e.py', ASK, 'the self-test does not excuse the suite after it'],
  ['python3 e2e/rls_e2e.py && python3 e2e/target_selftest.py', ASK, 'the self-test does not excuse the suite before it'],
  ['python3 e2e/target_selftest.py; npm run test:rls', ASK, 'the self-test does not excuse a test:* script'],
  ['python3 e2e/rls_e2e.py e2e/target_selftest.py', ASK, 'the self-test is only an argument of another suite'],
  ['python3 e2e/target_selftest.py | python3 e2e/rls_e2e.py', ASK, 'piped into a suite'],
  ['python3 -m unittest e2e.rls_e2e', ASK, 'RF-045: a unittest run of an e2e module'],
  ['npm run test:e2e', ASK, 'the umbrella script'],
], ['none', 'prodLinked']);

// ===========================================================================
// P0-9 (written before implementation): RF-052 to RF-056. Requirement:
// "P0-9 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md. Existing
// rows that these criteria changed are marked "Changed for RF-0xx (P0-9)"
// where they stand above.
// ===========================================================================

// ---------------------------------------------------------------------------
// RF-052 / RF-053 - the staging allowances hold for this checkout only
//
// One project tree, staging configured and linked at its root:
//
//   <wrap>/project/                         the project root (CLAUDE_PROJECT_DIR)
//     scripts/hooks/guard.conf              PROD_REF, STAGING_REF
//     supabase/.temp/project-ref            the staging ref
//     supabase/functions/
//     e2e/x.py, e2e/saas/y.py
//     src/components/                       a plain subdirectory
//     packages/api/supabase/.temp/project-ref   a subdirectory with its own supabase/ (production ref)
//     packages/api/src/
//     packages/bare/supabase/               its own supabase/ folder, no link file
//     .claude/worktrees/wt/                 a git worktree: `.git` is a file
//       e2e/x.py, src/, supabase/.temp/project-ref (production ref)
//     vendor/clone/                         a nested clone: `.git` is a directory
//       e2e/x.py, supabase/.temp/project-ref (production ref)
//   <wrap>/other/                           a sibling checkout outside the project
//     e2e/x.py, supabase/.temp/project-ref (production ref)
//
// The hook JSON carries `cwd`, as Claude Code sends it. The effective
// directory of a command is that cwd after any `cd` on the line (or a
// `--workdir` for the Supabase CLI). Paths are real paths (no symlinks).
// ---------------------------------------------------------------------------

const WRAP = realpathSync(mkdtempSync(join(tmpdir(), 'guard-bash-tree-')));
TEMP_DIRS.push(WRAP);

const TREE = (() => {
  const root = join(WRAP, 'project');
  const other = join(WRAP, 'other');
  const wt = join(root, '.claude', 'worktrees', 'wt');
  const clone = join(root, 'vendor', 'clone');
  const put = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const dirs = (...paths) => paths.forEach((path) => mkdirSync(path, { recursive: true }));
  const suite = 'print("suite")\n';
  const pkg = '{ "scripts": { "test:rls": "python3 e2e/x.py" } }\n';

  put(join(root, 'scripts', 'hooks', 'guard.conf'), `PROD_REF=${PROD}\nSTAGING_REF=${STAGING}\n`);
  put(join(root, 'supabase', '.temp', 'project-ref'), STAGING);
  put(join(root, 'e2e', 'x.py'), suite);
  put(join(root, 'e2e', 'saas', 'y.py'), suite);
  put(join(root, 'package.json'), pkg);
  dirs(join(root, 'supabase', 'functions'), join(root, 'src', 'components'), join(root, 'packages', 'api', 'src'));
  put(join(root, 'packages', 'api', 'supabase', '.temp', 'project-ref'), PROD);
  put(join(root, 'packages', 'api', 'e2e', 'x.py'), suite);
  dirs(join(root, 'packages', 'bare', 'supabase'));

  put(join(wt, '.git'), 'gitdir: ../../../.git/worktrees/wt\n');
  put(join(wt, 'supabase', '.temp', 'project-ref'), PROD);
  put(join(wt, 'e2e', 'x.py'), suite);
  put(join(wt, 'package.json'), pkg);
  dirs(join(wt, 'src'));

  dirs(join(clone, '.git'));
  put(join(clone, 'supabase', '.temp', 'project-ref'), PROD);
  put(join(clone, 'e2e', 'x.py'), suite);
  put(join(clone, 'package.json'), pkg);

  put(join(other, 'supabase', '.temp', 'project-ref'), PROD);
  put(join(other, 'e2e', 'x.py'), suite);
  put(join(other, 'package.json'), pkg);

  return {
    root,
    other,
    wt,
    clone,
    wrap: WRAP,
    plain: join(root, 'src', 'components'),
    supabaseDir: join(root, 'supabase'),
    functionsDir: join(root, 'supabase', 'functions'),
    e2eDir: join(root, 'e2e'),
    ownSupabase: join(root, 'packages', 'api'),
    belowOwnSupabase: join(root, 'packages', 'api', 'src'),
    bareSupabase: join(root, 'packages', 'bare'),
    wtSrc: join(wt, 'src'),
  };
})();

/** Run the hook for one command with a `cwd` in the hook JSON; the project is always TREE.root. */
function runInTree(command, cwd) {
  return runRaw(JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }), TREE.root);
}

/** Rows are [key of TREE for the hook cwd, command, expected decision, reason]. */
function treeTable(title, rows) {
  describe(title, () => {
    for (const [where, command, want, reason] of rows) {
      const shown = command.split(WRAP).join('<wrap>');
      it(`${want} [cwd=${where}]: ${JSON.stringify(shown)} - ${reason}`, () => {
        const got = decisionOf(runInTree(command, TREE[where]));
        assert.equal(got, want, `${reason}\ncommand: ${command}\nhook cwd: ${TREE[where]}\nproject root: ${TREE.root}`);
      });
    }
  });
}

describe('P0-9: the project tree fixture is what the tables below assume', () => {
  it('a remote supabase call at the root is linked to staging, and an e2e run at the root is allowed', () => {
    assert.equal(decisionOf(runInTree('supabase db push', TREE.root)), ALLOW);
    assert.equal(decisionOf(runInTree('python3 e2e/x.py', TREE.root)), ALLOW);
    assert.equal(decisionOf(runInTree('npm run test:rls', TREE.root)), ALLOW);
  });
  it('a hook cwd changes nothing for rules that do not depend on the directory', () => {
    assert.equal(decisionOf(runInTree('git status', TREE.wt)), ALLOW);
    assert.equal(decisionOf(runInTree('git push origin main', TREE.wt)), DENY);
    assert.equal(decisionOf(runInTree(`echo ${PROD}`, TREE.root)), ASK);
  });
});

for (const call of ['supabase db push', 'supabase functions deploy report']) {
  treeTable(`P0-9 RF-052: "${call}" by the directory the hook reports (cwd)`, [
    ['root', call, ALLOW, 'the project root: linked to staging'],
    ['plain', call, ALLOW, 'a plain subdirectory: no supabase/ of its own up to the root'],
    ['supabaseDir', call, ALLOW, "the root's own supabase/ folder"],
    ['functionsDir', call, ALLOW, "below the root's own supabase/ folder"],
    ['e2eDir', call, ALLOW, 'another plain subdirectory'],
    ['ownSupabase', call, ASK, 'a subdirectory with its own supabase/: the CLI uses that link, not the root one'],
    ['belowOwnSupabase', call, ASK, 'below a subdirectory that has its own supabase/'],
    ['bareSupabase', call, ASK, 'its own supabase/ folder, even with no link file in it'],
    ['wt', call, ASK, 'a git worktree with its own link (production)'],
    ['wtSrc', call, ASK, 'a subdirectory of the worktree'],
    ['clone', call, ASK, 'a nested clone with its own link'],
    ['other', call, ASK, 'a checkout outside the project'],
    ['wrap', call, ASK, 'the parent of the project: outside it'],
  ]);

  treeTable(`P0-9 RF-052: "${call}" after cd`, [
    ['root', `cd src/components && ${call}`, ALLOW, 'cd into a plain subdirectory'],
    ['root', `cd ${TREE.plain} && ${call}`, ALLOW, 'cd by absolute path into a plain subdirectory'],
    ['plain', `cd ../.. && ${call}`, ALLOW, 'cd back up to the root'],
    ['wt', `cd ${TREE.root} && ${call}`, ALLOW, 'from the worktree, cd by absolute path to the project root'],
    ['other', `cd ${TREE.root} && ${call}`, ALLOW, 'from outside, cd by absolute path to the project root'],
    ['root', `cd packages/api && ${call}`, ASK, 'cd into a subdirectory with its own supabase/'],
    ['root', `cd packages/api/src && ${call}`, ASK, 'cd below a subdirectory with its own supabase/'],
    ['root', `cd packages/bare && ${call}`, ASK, 'cd into a directory with an empty supabase/ of its own'],
    ['root', `cd .claude/worktrees/wt && ${call}`, ASK, 'the finding: cd into a worktree, then push'],
    ['root', `cd .claude/worktrees/wt; ${call}`, ASK, 'cd with ;'],
    ['root', `(cd .claude/worktrees/wt && ${call})`, ASK, 'cd in a subshell'],
    ['root', `cd ./.claude/worktrees/wt/src && ${call}`, ASK, 'cd into a subdirectory of the worktree'],
    ['root', `cd "${TREE.wt}" && ${call}`, ASK, 'cd by quoted absolute path into the worktree'],
    ['root', `cd vendor/clone && ${call}`, ASK, 'cd into a nested clone'],
    ['root', `cd ../other && ${call}`, ASK, 'cd to a sibling checkout'],
    ['root', `cd ${TREE.other} && ${call}`, ASK, 'cd by absolute path to a sibling checkout'],
    ['root', `cd .. && ${call}`, ASK, 'cd out of the project'],
    ['root', `cd src && cd ../packages/api && ${call}`, ASK, 'two cd steps ending in a directory with its own supabase/'],
    ['root', `bash -c "cd .claude/worktrees/wt && ${call}"`, ASK, 'cd inside a bash -c string'],
    ['plain', `cd ../../packages/api && ${call}`, ASK, 'from a plain subdirectory into one with its own supabase/'],
    ['root', `cd "$TARGET_DIR" && ${call}`, ASK, 'cd to a directory held in a variable: not provably this checkout'],
    ['root', `cd $(git worktree list | tail -1 | cut -d" " -f1) && ${call}`, ASK, 'cd to the output of a command'],
    ['root', `cd - && ${call}`, ASK, 'cd to the previous directory, which the guard cannot know'],
    ['root', `cd && ${call}`, ASK, 'cd with no argument goes to the home directory'],
  ]);

  const [, ...rest] = call.split(' ');
  const verb = rest.join(' ');
  treeTable(`P0-9 RF-052: "${call}" with --workdir`, [
    ['root', `supabase --workdir . ${verb}`, ALLOW, '--workdir naming the root'],
    ['root', `supabase --workdir ${TREE.root} ${verb}`, ALLOW, '--workdir naming the root by absolute path'],
    ['other', `supabase --workdir ${TREE.root} ${verb}`, ALLOW, 'from outside, --workdir naming the project root'],
    ['root', `supabase --workdir .claude/worktrees/wt ${verb}`, ASK, '--workdir naming the worktree'],
    ['root', `supabase --workdir=.claude/worktrees/wt ${verb}`, ASK, '--workdir=<worktree>'],
    ['root', `supabase ${verb} --workdir .claude/worktrees/wt`, ASK, '--workdir after the subcommand'],
    ['root', `supabase --workdir ${TREE.wt} ${verb}`, ASK, '--workdir naming the worktree by absolute path'],
    ['root', `supabase --workdir packages/api ${verb}`, ASK, '--workdir naming a directory with its own supabase/'],
    ['root', `supabase --workdir vendor/clone ${verb}`, ASK, '--workdir naming a nested clone'],
    ['root', `supabase --workdir ../other ${verb}`, ASK, '--workdir naming a sibling checkout'],
    ['root', `supabase --workdir ${TREE.other} ${verb}`, ASK, '--workdir naming a sibling checkout by absolute path'],
    ['root', `npx supabase --workdir ../other ${verb}`, ASK, 'through npx'],
    ['root', `supabase --workdir "$TARGET_DIR" ${verb}`, ASK, '--workdir held in a variable'],
    ['root', `cd src && supabase --workdir ../packages/api ${verb}`, ASK, '--workdir relative to the directory after cd'],
    ['wt', `supabase --workdir . ${verb}`, ASK, 'in the worktree, --workdir . is the worktree'],
  ]);
}

treeTable('P0-9 RF-052 (assumed reading): other ways to move the Supabase CLI to another directory', [
  ['root', 'pushd .claude/worktrees/wt && supabase db push', ASK, 'C1: pushd changes directory like cd'],
  ['root', 'env -C .claude/worktrees/wt supabase db push', ASK, 'C1: env -C changes directory first'],
  ['root', 'SUPABASE_WORKDIR=.claude/worktrees/wt supabase db push', ASK, 'C2: the CLI reads --workdir from SUPABASE_WORKDIR'],
  ['root', `SUPABASE_WORKDIR=${TREE.other} supabase functions deploy report`, ASK, 'C2: SUPABASE_WORKDIR naming a sibling checkout'],
]);

treeTable('P0-9 RF-052: calls that never depended on the link stay allowed in any directory', [
  ['wt', 'supabase --help', ALLOW, '--help'],
  ['wt', 'supabase db push --help', ALLOW, '--help on a subcommand'],
  ['wt', 'supabase db reset --local', ALLOW, 'the local stack'],
  ['other', 'supabase start', ALLOW, 'the local stack'],
  ['ownSupabase', 'supabase migration new add_table', ALLOW, 'creates a local file'],
  ['wt', 'git commit -m "supabase db push from a worktree asks"', ALLOW, 'rule 4: a mention'],
]);

treeTable('P0-9 RF-053: an e2e file is allowed only when it resolves to <project root>/e2e/', [
  ['root', 'python3 e2e/x.py', ALLOW, "this project's own suite"],
  ['root', 'python3 ./e2e/saas/y.py', ALLOW, "a subdirectory of this project's e2e/"],
  ['root', `python3 ${TREE.root}/e2e/x.py`, ALLOW, "this project's suite by absolute path"],
  ['root', 'python3 src/../e2e/x.py', ALLOW, "dot segments that resolve to this project's e2e/"],
  ['root', 'cd e2e && python3 x.py', ALLOW, "cd into this project's e2e/"],
  ['root', 'cd e2e/saas && python3 y.py', ALLOW, "cd into a subdirectory of this project's e2e/"],
  ['e2eDir', 'python3 x.py', ALLOW, "the hook reports this project's e2e/ as the directory"],
  ['plain', 'python3 ../../e2e/x.py', ALLOW, "from a plain subdirectory, a path that resolves to this project's e2e/"],
  ['plain', `python3 ${TREE.root}/e2e/x.py`, ALLOW, "from a plain subdirectory, this project's suite by absolute path"],
  ['root', 'python3 ../other/e2e/x.py', ASK, 'the finding: an e2e file in a sibling checkout'],
  ['root', `python3 ${TREE.other}/e2e/x.py`, ASK, 'the finding: an absolute path to an e2e file in another checkout'],
  ['root', `python3 "${TREE.other}/e2e/x.py"`, ASK, 'the same, quoted'],
  ['root', 'python3 .claude/worktrees/wt/e2e/x.py', ASK, "a worktree's e2e file by relative path"],
  ['root', `python3 ${TREE.wt}/e2e/x.py`, ASK, "a worktree's e2e file by absolute path"],
  ['root', 'python3 vendor/clone/e2e/x.py', ASK, "a nested clone's e2e file"],
  ['root', 'python3 packages/api/e2e/x.py', ASK, 'an e2e folder that is not the one at the project root'],
  ['root', 'python3 e2e/../../other/e2e/x.py', ASK, "starts in this project's e2e/ and resolves outside it"],
  ['root', 'python3 e2e/../.claude/worktrees/wt/e2e/x.py', ASK, "starts in this project's e2e/ and resolves into the worktree"],
  ['root', './.claude/worktrees/wt/e2e/x.py', ASK, "a worktree's e2e file executed directly"],
  ['root', `${TREE.other}/e2e/x.py`, ASK, "another checkout's e2e file executed directly"],
  ['root', 'bash -c "python3 ../other/e2e/x.py"', ASK, 'bash -c string'],
  ['root', 'python3 e2e/x.py && python3 ../other/e2e/x.py', ASK, 'an allowed run does not excuse the one after it'],
  ['root', 'cd .claude/worktrees/wt && python3 e2e/x.py', ASK, 'cd into the worktree, then its suite'],
  ['root', 'cd .claude/worktrees/wt/e2e && python3 x.py', ASK, "cd into the worktree's e2e/"],
  ['root', 'cd ../other && python3 e2e/x.py', ASK, 'cd to a sibling checkout, then its suite'],
  ['root', `cd ${TREE.other}/e2e && python3 x.py`, ASK, "cd by absolute path into another checkout's e2e/"],
  ['root', 'cd vendor/clone && python3 -m e2e.x', ASK, 'a module run inside a nested clone'],
  ['root', 'cd ../other && python3 -m unittest e2e.x', ASK, 'a unittest run inside a sibling checkout'],
  ['root', 'env -C ../other python3 e2e/x.py', ASK, 'env -C into a sibling checkout'],
  ['plain', 'python3 e2e/x.py', ASK, 'from a plain subdirectory the path resolves to src/components/e2e/, not the root e2e/'],
  ['wt', 'python3 e2e/x.py', ASK, "the hook reports the worktree: its own e2e/ is not this project's"],
  ['wtSrc', 'python3 ../e2e/x.py', ASK, "inside the worktree, a path to the worktree's e2e/"],
  ['clone', 'python3 e2e/x.py', ASK, 'the hook reports a nested clone'],
  ['other', 'python3 e2e/x.py', ASK, 'the hook reports a checkout outside the project'],
  ['wrap', 'python3 other/e2e/x.py', ASK, 'the hook reports the parent of the project'],
]);

treeTable('P0-9 RF-053: the effective directory must be inside this project and outside any nested checkout', [
  ['wt', `python3 ${TREE.root}/e2e/x.py`, ASK, "the file is this project's, but the directory is a worktree"],
  ['wtSrc', `python3 ${TREE.root}/e2e/x.py`, ASK, "the file is this project's, but the directory is below a worktree"],
  ['wt', 'python3 ../../../e2e/x.py', ASK, "a relative path from the worktree to this project's e2e/"],
  ['clone', `python3 ${TREE.root}/e2e/x.py`, ASK, "the file is this project's, but the directory is a nested clone"],
  ['other', `python3 ${TREE.root}/e2e/x.py`, ASK, "the file is this project's, but the directory is outside the project"],
  ['wrap', 'python3 project/e2e/x.py', ASK, "the file is this project's, but the directory is the parent of the project"],
  ['root', `cd .claude/worktrees/wt && python3 ${TREE.root}/e2e/x.py`, ASK, 'cd into the worktree first'],
  ['root', `cd ../other && python3 ${TREE.root}/e2e/x.py`, ASK, 'cd out of the project first'],
  ['wt', `cd ${TREE.root} && python3 e2e/x.py`, ALLOW, 'from the worktree, cd to the project root and run its own suite'],
  ['other', `cd ${TREE.root}/e2e && python3 x.py`, ALLOW, "from outside, cd into this project's e2e/"],
]);

treeTable('P0-9 RF-053: Python reading its program from standard input asks', [
  ['root', 'git show HEAD:e2e/x.py | python3 -', ASK, 'the finding: an e2e file from another commit piped into python3 -'],
  ['root', 'git show HEAD:e2e/x.py | python3', ASK, 'python3 with no argument reads the program from the pipe'],
  ['root', 'git show main:e2e/x.py | python -', ASK, 'python instead of python3'],
  ['root', 'git -C ../other show HEAD:e2e/x.py | python3 -', ASK, "another checkout's e2e file from git"],
  ['root', 'cat ../other/e2e/x.py | python3 -', ASK, "another checkout's e2e file through cat"],
  ['root', 'cat e2e/x.py | python3 -', ASK, 'even this project\'s own file: the criterion is "reading its program from stdin"'],
  ['root', 'python3 - < ../other/e2e/x.py', ASK, 'redirected in, with -'],
  ['root', 'python3 < ../other/e2e/x.py', ASK, 'redirected in, no argument'],
  ['root', 'python3 < e2e/x.py', ASK, "this project's own file redirected in"],
  ['root', 'python3 /dev/stdin < ../other/e2e/x.py', ASK, '/dev/stdin as the script'],
  ['root', 'git show HEAD:e2e/x.py | python3 -u -', ASK, 'an interpreter flag before -'],
  ['root', 'bash -c "git show HEAD:e2e/x.py | python3 -"', ASK, 'bash -c string'],
  ['root', 'git show HEAD:e2e/x.py | env DRILL_E2E_TARGET=staging python3 -', ASK, 'through env; RF-010: the variable is not what decides'],
]);

treeTable('P0-9 RF-053: Python given a dynamic script argument asks', [
  ['root', 'python3 "$f"', ASK, 'the finding: the script is held in a variable'],
  ['root', 'python3 $f', ASK, 'unquoted variable'],
  ['root', 'python3 "${SUITE}"', ASK, 'braced variable'],
  ['root', 'f=../other/e2e/x.py; python3 "$f"', ASK, 'the variable is set on the same line to another checkout'],
  ['root', 'for f in ../other/e2e/*.py; do python3 "$f"; done', ASK, "a loop over another checkout's suites"],
  ['root', 'for f in e2e/*.py; do python3 "$f"; done', ASK, "a loop over this project's suites: still a dynamic argument"],
  ['root', 'python3 "e2e/$name.py"', ASK, 'a path with a variable inside it'],
  ['root', 'python3 "$DIR/e2e/x.py"', ASK, 'a directory held in a variable'],
  ['root', 'python3 "$(git rev-parse --show-toplevel)/e2e/x.py"', ASK, 'a path built from a command substitution'],
  ['root', 'python3 $(ls ../other/e2e/*.py | head -1)', ASK, 'the script is the output of a command'],
  ['root', 'python3 `ls e2e/*.py | head -1`', ASK, 'the script is the output of a command, in backticks'],
  ['root', 'python3 -u "$f" --verbose', ASK, 'a flag before and an argument after'],
  ['root', 'bash -c \'python3 "$f"\'', ASK, 'bash -c string'],
]);

treeTable('P0-9 RF-053: Python that is not an e2e run stays allowed', [
  ['root', 'python3 -c "print(1)"', ALLOW, 'inline Python'],
  ['root', 'python3 scripts/tool.py', ALLOW, 'a literal script outside e2e/'],
  ['root', "python3 - <<'EOF'\nprint('hello')\nEOF", ALLOW, 'a program in a quoted here-document is on the line for the guard to read'],
  ['root', 'python3 -m json.tool package.json', ALLOW, 'a standard-library module'],
  ['wt', 'python3 scripts/tool.py', ALLOW, 'a literal script outside e2e/, in the worktree'],
  ['root', 'cat ../other/e2e/x.py', ALLOW, "rule 4: reading another checkout's e2e file"],
  ['root', 'git show HEAD:e2e/x.py', ALLOW, 'rule 4: showing an e2e file from another commit'],
  ['root', 'git commit -m "python3 ../other/e2e/x.py now asks"', ALLOW, 'rule 4: a mention'],
]);

treeTable('P0-9 RF-053: a test:* package script is allowed only when the effective directory is the project root', [
  ['root', 'npm run test:rls', ALLOW, 'at the project root'],
  ['root', 'cd . && npm run test:rls', ALLOW, 'cd . stays at the root'],
  ['plain', 'cd ../.. && npm run test:rls', ALLOW, 'cd back up to the root'],
  ['wt', `cd ${TREE.root} && npm run test:rls`, ALLOW, 'from the worktree, cd by absolute path to the project root'],
  ['root', 'yarn test:rls', ALLOW, 'yarn at the root'],
  ['root', 'pnpm run test:rls', ALLOW, 'pnpm at the root'],
  ['plain', 'npm run test:rls', ASK, 'a plain subdirectory is not the root'],
  ['e2eDir', 'npm run test:rls', ASK, "this project's e2e/ is not the root"],
  ['ownSupabase', 'npm run test:rls', ASK, 'a subdirectory'],
  ['wt', 'npm run test:rls', ASK, "the finding: a worktree's package.json runs the worktree's suites"],
  ['wtSrc', 'npm run test:rls', ASK, 'below the worktree'],
  ['clone', 'npm run test:rls', ASK, 'a nested clone'],
  ['other', 'npm run test:rls', ASK, 'a checkout outside the project'],
  ['wrap', 'npm run test:rls', ASK, 'the parent of the project'],
  ['root', 'cd .claude/worktrees/wt && npm run test:rls', ASK, 'cd into the worktree'],
  ['root', '(cd .claude/worktrees/wt && npm run test:e2e)', ASK, 'cd in a subshell, the umbrella script'],
  ['root', 'cd ../other && npm run test:rls', ASK, 'cd to a sibling checkout'],
  ['root', `cd ${TREE.other} && yarn test:rls`, ASK, 'cd by absolute path, yarn'],
  ['root', 'cd vendor/clone && pnpm test:rls', ASK, 'cd into a nested clone, pnpm'],
  ['root', 'cd src && npm run test:rls', ASK, 'cd into a plain subdirectory'],
  ['root', 'cd "$TARGET_DIR" && npm run test:rls', ASK, 'cd to a directory held in a variable'],
  ['root', 'bash -c "cd ../other && npm run test:rls"', ASK, 'bash -c string'],
  ['root', 'npm run test:rls && cd ../other && npm run test:rls', ASK, 'an allowed run does not excuse the one after the cd'],
]);

treeTable("P0-9 RF-053 (assumed reading): a runner's own directory flag moves the effective directory", [
  ['root', 'npm --prefix .claude/worktrees/wt run test:rls', ASK, 'C3: npm --prefix'],
  ['root', 'npm run test:rls --prefix ../other', ASK, 'C3: npm --prefix after the script'],
  ['root', `npm --prefix=${TREE.other} run test:rls`, ASK, 'C3: npm --prefix=<dir>'],
  ['root', 'npm -C ../other run test:rls', ASK, 'C3: npm -C'],
  ['root', 'yarn --cwd ../other test:rls', ASK, 'C3: yarn --cwd'],
  ['root', 'pnpm -C ../other test:rls', ASK, 'C3: pnpm -C'],
  ['root', 'pnpm --dir .claude/worktrees/wt run test:rls', ASK, 'C3: pnpm --dir'],
  ['root', 'bun run --cwd ../other test:rls', ASK, 'C3: bun --cwd'],
  ['root', 'env -C ../other npm run test:rls', ASK, 'C3: env -C'],
]);

treeTable('P0-9 RF-053: package scripts that are not test:* stay allowed anywhere', [
  ['wt', 'npm test', ALLOW, 'plain npm test in the worktree'],
  ['plain', 'npm run lint', ALLOW, 'lint in a subdirectory'],
  ['other', 'npm run build', ALLOW, 'build in another checkout'],
]);

// ---------------------------------------------------------------------------
// RF-054 - destructive operations on staging ask
// ---------------------------------------------------------------------------

table('P0-9 RF-054: supabase migration down asks in every configuration', [
  ['supabase migration down', ASK_EVERYWHERE, 'reverts the last migration on the linked project'],
  ['supabase migration down --linked', ASK_EVERYWHERE, 'explicit --linked'],
  ['supabase migration down --last 2', ASK_EVERYWHERE, 'with --last'],
  ['supabase migration down --linked --yes', ASK_EVERYWHERE, 'confirmed in advance'],
  [`supabase migration down --project-ref ${STAGING}`, ASK_EVERYWHERE, 'naming staging does not excuse it'],
  ['supabase migration down --db-url "$DATABASE_URL"', ASK_EVERYWHERE, 'an explicit target in a variable'],
  ['supabase --debug migration down', ASK_EVERYWHERE, 'global flag before the verb'],
  ['supabase --workdir . migration down', ASK_EVERYWHERE, 'global flag with a value'],
  ['npx supabase migration down', ASK_EVERYWHERE, 'through npx'],
  ['./node_modules/.bin/supabase migration down', ASK_EVERYWHERE, 'by path'],
  ['cd supabase && supabase migration down', ASK_EVERYWHERE, 'cd then run'],
  ['bash -c "supabase migration down"', ASK_EVERYWHERE, 'bash -c string'],
  ['eval "supabase migration down --linked"', ASK_EVERYWHERE, 'eval string'],
  ['(supabase migration down)', ASK_EVERYWHERE, 'subshell'],
  ['time supabase migration down', ASK_EVERYWHERE, 'a wrapper'],
  ['echo y | supabase migration down', ASK_EVERYWHERE, 'piped confirmation'],
  ['supabase migration down # --local', ASK_EVERYWHERE, 'a --local inside a comment does not count'],
  ['supabase migration down; echo --help', ASK_EVERYWHERE, 'the --help belongs to another command'],
  ['supabase migration up && supabase migration down', ASK_EVERYWHERE, 'after a call that staging would allow'],
]);

table('P0-9 RF-054: what the migration-down rule leaves alone', [
  ['supabase migration up', LINK_DECIDES, 'migration up still follows the link'],
  ['supabase migration list', LINK_DECIDES, 'migration list still follows the link'],
  ['supabase migration new down', ALLOW, 'a new local migration file that happens to be called down'],
  ['git commit -m "supabase migration down now asks"', ALLOW, 'rule 4: a mention'],
  ['grep -rn "supabase migration down" docs/', ALLOW, 'rule 4: a grep pattern'],
]);

table('P0-9 RF-054: deleting or pausing the staging project with the CLI asks in every configuration', [
  [`supabase projects delete ${STAGING}`, ASK_EVERYWHERE, 'projects delete naming staging'],
  [`supabase projects delete "${STAGING}"`, ASK_EVERYWHERE, 'quoted ref'],
  [`supabase projects delete ${STAGING} --yes`, ASK_EVERYWHERE, 'confirmed in advance'],
  [`supabase projects delete --project-ref ${STAGING}`, ASK_EVERYWHERE, 'the ref given with --project-ref'],
  ['supabase projects delete', ASK_EVERYWHERE, 'no ref: the CLI would prompt or use the link'],
  [`supabase --debug projects delete ${STAGING}`, ASK_EVERYWHERE, 'global flag before the verb'],
  [`npx supabase projects delete ${STAGING}`, ASK_EVERYWHERE, 'through npx'],
  [`bash -c "supabase projects delete ${STAGING}"`, ASK_EVERYWHERE, 'bash -c string'],
  [`echo y | supabase projects delete ${STAGING}`, ASK_EVERYWHERE, 'piped confirmation'],
  [`supabase projects pause ${STAGING}`, ASK_EVERYWHERE, 'projects pause naming staging'],
  [`supabase projects pause --project-ref ${STAGING}`, ASK_EVERYWHERE, 'projects pause with --project-ref'],
  [`npx supabase projects pause ${STAGING}`, ASK_EVERYWHERE, 'projects pause through npx'],
]);

table('P0-9 RF-054: pausing the staging project over the management API asks in every configuration', [
  [`curl -X POST ${MGMT}/pause`, ASK_EVERYWHERE, '-X POST'],
  [`curl -XPOST ${MGMT}/pause`, ASK_EVERYWHERE, '-XPOST joined'],
  [`curl --request POST ${MGMT}/pause`, ASK_EVERYWHERE, '--request POST'],
  [`curl -X post ${MGMT}/pause`, ASK_EVERYWHERE, 'lower-case method'],
  [`curl ${MGMT}/pause -X POST`, ASK_EVERYWHERE, 'method after the URL'],
  [`curl -X POST "${MGMT}/pause"`, ASK_EVERYWHERE, 'quoted URL'],
  [`curl -X POST ${MGMT}/pause/`, ASK_EVERYWHERE, 'trailing slash'],
  [`curl -X POST "${MGMT}/pause?x=1"`, ASK_EVERYWHERE, 'a query string after the path'],
  [`curl -d '' ${MGMT}/pause`, ASK_EVERYWHERE, 'POST implied by a body'],
  [`curl -X POST --url ${MGMT}/pause`, ASK_EVERYWHERE, 'given with --url'],
  [`curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -X POST ${MGMT}/pause`, ASK_EVERYWHERE, 'flags before the method'],
  [`wget --method=POST ${MGMT}/pause`, ASK_EVERYWHERE, 'wget --method=POST'],
  [`wget --post-data='' ${MGMT}/pause`, ASK_EVERYWHERE, 'wget --post-data'],
  [`bash -c "curl -X POST ${MGMT}/pause"`, ASK_EVERYWHERE, 'bash -c string'],
  [`curl -X GET ${MGMT}/branches && curl -X POST ${MGMT}/pause`, ASK_EVERYWHERE, 'an allowed request does not excuse the pause'],
  [`curl -X GET ${MGMT}/branches -: -X POST ${MGMT}/pause`, ASK_EVERYWHERE, 'the second request of one curl call (--next)'],
]);

table('P0-9 RF-054 (assumed reading): pause, like delete, is judged on the resolved path and a method that may be the dangerous one', [
  [`curl -X POST ${MGMT}/branches/../pause`, ASK_EVERYWHERE, 'D1: dot segments resolve to the pause endpoint'],
  [`curl -X POST ${MGMT}/./pause`, ASK_EVERYWHERE, 'D1: a . segment before pause'],
  [`curl -X "$METHOD" ${MGMT}/pause`, ASK_EVERYWHERE, 'D2: a method held in a variable is not provably something other than POST'],
]);

table('P0-9 RF-054: deleting staging test data stays allowed once STAGING_REF is set', [
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh --yes`, NAMES_STAGING, 'the delete script, confirmed'],
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh --yes a@example.com`, NAMES_STAGING, 'the delete script for one account'],
  [`SUPABASE_PROJECT_REF=${STAGING} bash scripts/delete-test-data.sh --yes`, NAMES_STAGING, 'the delete script through bash'],
  [`curl -X DELETE "https://${STAGING}.supabase.co/rest/v1/boreholes?id=eq.1"`, NAMES_STAGING, 'a REST DELETE on a staging table'],
  [`curl -X DELETE "https://${STAGING}.supabase.co/rest/v1/pipe_records?created_by=eq.abc" -H "apikey: $SUPABASE_ANON_KEY"`, NAMES_STAGING, 'a REST DELETE with a key header'],
  [`curl -X DELETE "https://${STAGING}.supabase.co/auth/v1/admin/users/00000000-0000-0000-0000-000000000001"`, NAMES_STAGING, 'deleting a staging test account'],
  [`curl -X POST ${MGMT}/database/query -d @query.json`, NAMES_STAGING, 'SQL sent to the staging query endpoint'],
  [`curl -X POST ${MGMT}/database/query -H "Content-Type: application/json" -d '{"query":"delete from public.boreholes where created_by is not null"}'`, NAMES_STAGING, 'SQL sent to staging is not inspected: a delete'],
  [`curl -X POST ${MGMT}/database/query -d '{"query":"truncate public.pipe_records"}'`, NAMES_STAGING, 'SQL sent to staging is not inspected: a truncate'],
  [`curl -X POST ${MGMT}/database/query -d '{"query":"select 1 -- pause"}'`, NAMES_STAGING, 'the word pause in the body is not the pause endpoint'],
]);

table('P0-9 RF-054: the same destructive calls on any other project still ask', [
  [`curl -X POST https://api.supabase.com/v1/projects/${OTHER}/pause`, ASK, 'pausing another project'],
  [`curl -X POST https://api.supabase.com/v1/projects/${PROD}/pause`, ASK, 'pausing production: rule 5'],
  [`supabase projects pause ${OTHER}`, ASK, 'pausing another project with the CLI'],
  [`supabase migration down --project-ref ${OTHER}`, ASK, 'migration down on another project'],
  [`curl -X DELETE "https://${OTHER}.supabase.co/rest/v1/boreholes?id=eq.1"`, ASK, 'a REST DELETE on another project'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// RF-055 - GATE_UNIT_TEST_CMD on a command line asks
// ---------------------------------------------------------------------------

table('P0-9 RF-055: the gate with GATE_UNIT_TEST_CMD on the command line asks', [
  ['GATE_UNIT_TEST_CMD=true scripts/gate.sh quick', ASK, 'prefix assignment'],
  ['GATE_UNIT_TEST_CMD=true scripts/gate.sh full', ASK, 'prefix assignment, full mode'],
  ['GATE_UNIT_TEST_CMD=true scripts/gate.sh', ASK, 'prefix assignment, default mode'],
  ['GATE_UNIT_TEST_CMD=true ./scripts/gate.sh quick', ASK, './ path'],
  ['GATE_UNIT_TEST_CMD=true bash scripts/gate.sh quick', ASK, 'through bash'],
  ['GATE_UNIT_TEST_CMD="echo skipped" scripts/gate.sh quick', ASK, 'a quoted value'],
  ["GATE_UNIT_TEST_CMD=':' scripts/gate.sh quick", ASK, 'a single-quoted value'],
  ['GATE_UNIT_TEST_CMD="$CMD" scripts/gate.sh quick', ASK, 'a value held in a variable'],
  ['env GATE_UNIT_TEST_CMD=true scripts/gate.sh quick', ASK, 'through env'],
  ['env GATE_UNIT_TEST_CMD=true bash scripts/gate.sh full', ASK, 'through env and bash'],
  ['export GATE_UNIT_TEST_CMD=true; scripts/gate.sh quick', ASK, 'exported first, ;'],
  ['export GATE_UNIT_TEST_CMD=true && scripts/gate.sh quick', ASK, 'exported first, &&'],
  ['export GATE_UNIT_TEST_CMD=true\nscripts/gate.sh quick', ASK, 'exported on the line before'],
  ['GATE_UNIT_TEST_CMD=true; export GATE_UNIT_TEST_CMD; scripts/gate.sh quick', ASK, 'assigned, then exported'],
  ['declare -x GATE_UNIT_TEST_CMD=true; scripts/gate.sh quick', ASK, 'declare -x'],
  ['cd scripts && GATE_UNIT_TEST_CMD=true ./gate.sh quick', ASK, 'cd then run'],
  ['bash -c "GATE_UNIT_TEST_CMD=true scripts/gate.sh quick"', ASK, 'bash -c string'],
  ['GATE_UNIT_TEST_CMD=true npm run gate', ASK, 'the gate behind a package script'],
  ['npm test && GATE_UNIT_TEST_CMD=true scripts/gate.sh quick', ASK, 'after &&'],
], ALL_CONFIGS);

table('P0-9 RF-055: the gate without the variable stays allowed', [
  ['scripts/gate.sh quick', ALLOW, 'quick'],
  ['scripts/gate.sh full', ALLOW, 'full'],
  ['scripts/gate.sh', ALLOW, 'default mode'],
  ['./scripts/gate.sh quick', ALLOW, './ path'],
  ['bash scripts/gate.sh quick', ALLOW, 'through bash'],
  ['scripts/gate.sh quick 2>&1 | tail -20', ALLOW, 'with the output trimmed'],
  ['CI=1 scripts/gate.sh quick', ALLOW, 'another variable in front'],
  ['GATE_UNIT_TEST=true scripts/gate.sh quick', ALLOW, 'a variable whose name is only a prefix of it'],
], ALL_CONFIGS);

// ---------------------------------------------------------------------------
// RF-056 - guard details
// ---------------------------------------------------------------------------

/** Asks wherever the link does not prove staging; the staging-linked answer is pinned separately. */
const ASK_UNLESS_STAGING_LINKED = { none: ASK, prodLinked: ASK, stagingSetProdLinked: ASK, stagingSetNoLink: ASK };

table('P0-9 RF-056: --version does not excuse a remote Supabase call', [
  ['supabase storage rm --version 1 ss:///photos/a.jpg', ASK_UNLESS_STAGING_LINKED, 'the finding: --version on a destructive call'],
  ['supabase functions delete report --version 1', ASK_UNLESS_STAGING_LINKED, 'the finding: --version on a destructive call'],
  ['supabase secrets unset API_KEY --version', ASK_UNLESS_STAGING_LINKED, '--version after a remote verb'],
  ['supabase migration down --version 20260101000000', ASK_EVERYWHERE, '--version on migration down (RF-054)'],
  ['supabase db reset --linked --version', ASK_EVERYWHERE, '--version on a non-local reset'],
  [`supabase projects delete ${STAGING} --version`, ASK_EVERYWHERE, '--version on projects delete'],
  [`supabase projects delete ${OTHER} --version 1`, ASK_EVERYWHERE, '--version on deleting another project'],
  ['supabase projects create drill-staging --version', ASK_EVERYWHERE, '--version on projects create'],
  ['npx supabase functions delete report --version 1', ASK_UNLESS_STAGING_LINKED, 'through npx'],
  ['bash -c "supabase storage rm --version 1 ss:///photos/a.jpg"', ASK_UNLESS_STAGING_LINKED, 'bash -c string'],
]);

// The Lead's brief for P0-9 says these two ask "on a staging link". The
// criterion's wording ("only --help / -h excuse a destructive Supabase call")
// supports it if `storage rm` and `functions delete` count as destructive
// calls that ask on staging; RF-054's list does not name them. Pinned as
// briefed and reported as an open question.
table('P0-9 RF-056 (assumed reading): with staging linked, the two calls from the finding ask', [
  ['supabase storage rm --version 1 ss:///photos/a.jpg', ASK, 'E1: as briefed'],
  ['supabase functions delete report --version 1', ASK, 'E1: as briefed'],
], ['stagingLinked']);

table('P0-9 RF-056 (assumed reading): --version after a subcommand is not the version call, so it excuses nothing', [
  ['supabase db push --version', ASK, 'E2: a remote call that is not provably staging'],
  ['supabase functions list --version', ASK, 'E2: a remote call that is not provably staging'],
], ['none', 'prodLinked', 'stagingSetProdLinked', 'stagingSetNoLink']);

table('P0-9 RF-056: --help and -h still excuse a call, and a bare --version runs nothing', [
  ['supabase functions delete --help', ALLOW, '--help on a destructive verb'],
  ['supabase functions delete report --help', ALLOW, '--help after an argument'],
  ['supabase functions delete -h', ALLOW, '-h'],
  ['supabase storage rm --help', ALLOW, '--help'],
  ['supabase migration down --help', ALLOW, '--help on migration down'],
  ['supabase migration down -h', ALLOW, '-h on migration down'],
  ['supabase db reset -h', ALLOW, '-h on db reset'],
  ['supabase projects delete --help', ALLOW, '--help on projects delete'],
  ['supabase --version', ALLOW, 'the bare version call'],
  ['npx supabase --version', ALLOW, 'the bare version call through npx'],
], ALL_CONFIGS);

table('P0-9 RF-056: a management-API path with a . or .. segment is the project itself', [
  [`curl -X DELETE ${MGMT}/.`, ASK_EVERYWHERE, 'the finding: /.'],
  [`curl -X DELETE ${MGMT}/./`, ASK_EVERYWHERE, 'the finding: /./'],
  [`curl -X DELETE ${MGMT}/x/..`, ASK_EVERYWHERE, 'the finding: /x/..'],
  [`curl -X DELETE ${MGMT}/x/../`, ASK_EVERYWHERE, '/x/../'],
  [`curl -X DELETE ${MGMT}/./.`, ASK_EVERYWHERE, '/./.'],
  [`curl -X DELETE ${MGMT}/branches/./..`, ASK_EVERYWHERE, '/branches/./..'],
  [`curl -X DELETE ${MGMT}/a/b/../..`, ASK_EVERYWHERE, 'two levels down and back'],
  [`curl -X DELETE "${MGMT}/.?confirm=true"`, ASK_EVERYWHERE, '/. with a query string'],
  [`curl --request DELETE "${MGMT}/x/.."`, ASK_EVERYWHERE, '--request, quoted'],
  [`curl ${MGMT}/. -X DELETE`, ASK_EVERYWHERE, 'method after the URL'],
  [`wget --method=DELETE ${MGMT}/./`, ASK_EVERYWHERE, 'wget'],
  [`bash -c "curl -X DELETE ${MGMT}/."`, ASK_EVERYWHERE, 'bash -c string'],
]);

table('P0-9 RF-056: curl -K / --config to a Supabase host asks in every configuration', [
  [`curl -K opts.txt ${MGMT}/branches`, ASK_EVERYWHERE, 'the finding: -K with the staging management API (the file may hold -X DELETE)'],
  [`curl --config opts.txt ${MGMT}/branches`, ASK_EVERYWHERE, 'the finding: --config'],
  [`curl -K opts.txt ${MGMT}`, ASK_EVERYWHERE, '-K with the project itself'],
  [`curl -s -K opts.txt ${MGMT}`, ASK_EVERYWHERE, '-K after another flag'],
  [`curl ${MGMT} -K opts.txt`, ASK_EVERYWHERE, '-K after the URL'],
  [`curl -Kopts.txt ${MGMT}`, ASK_EVERYWHERE, '-K joined to its value'],
  [`curl -sK opts.txt ${MGMT}`, ASK_EVERYWHERE, '-K at the end of a short group'],
  [`curl -K - ${MGMT}`, ASK_EVERYWHERE, '-K reading standard input'],
  [`curl --config "$CURL_OPTS" ${MGMT}/branches`, ASK_EVERYWHERE, '--config held in a variable'],
  [`curl -K opts.txt https://${STAGING}.supabase.co/rest/v1/boreholes`, ASK_EVERYWHERE, '-K with the staging project host'],
  [`curl --config opts.txt https://${STAGING}.supabase.co/rest/v1/`, ASK_EVERYWHERE, '--config with the staging project host'],
  ['curl -K opts.txt https://api.supabase.com/v1/projects', ASK_EVERYWHERE, '-K with the management API, no project'],
  [`bash -c "curl -K opts.txt ${MGMT}"`, ASK_EVERYWHERE, 'bash -c string'],
]);

table('P0-9 RF-056: a later +n or +o noexec cancels bash -n, so the management script runs', [
  ['bash -n +n scripts/delete-test-data.sh', ASK_EVERYWHERE, 'the finding: +n switches noexec off again'],
  ['bash -n +o noexec scripts/delete-test-data.sh', ASK_EVERYWHERE, 'the finding: +o noexec switches it off again'],
  ['bash -n +n scripts/create-user.sh a@example.com', ASK_EVERYWHERE, '+n, another script'],
  ['sh -n +n scripts/check-attribution.sh', ASK_EVERYWHERE, 'sh'],
  ['bash -n -x +n scripts/delete-test-data.sh', ASK_EVERYWHERE, 'another flag in between'],
  ['bash -nx +n scripts/delete-test-data.sh', ASK_EVERYWHERE, '-n inside a short group, then +n'],
  ['bash -n +nx scripts/delete-test-data.sh', ASK_EVERYWHERE, '+n inside a short group'],
  ['bash -o noexec +o noexec scripts/delete-test-data.sh', ASK_EVERYWHERE, '-o noexec, then +o noexec'],
  ['bash -n +o noexec scripts/delete-test-data.sh --yes', ASK_EVERYWHERE, 'with the confirming argument'],
]);

table('P0-9 RF-056: a dynamic word between env and a management script asks', [
  [`SUPABASE_PROJECT_REF=${STAGING} env $EXTRA scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'the finding: $EXTRA may hold SUPABASE_PROJECT_REF=<another project>'],
  [`SUPABASE_PROJECT_REF=${STAGING} env "$EXTRA" scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'quoted variable'],
  [`SUPABASE_PROJECT_REF=${STAGING} env \${EXTRA} scripts/delete-test-data.sh --yes`, ASK_EVERYWHERE, 'braced variable'],
  [`SUPABASE_PROJECT_REF=${STAGING} env $(cat extra.env) scripts/delete-test-data.sh`, ASK_EVERYWHERE, 'a command substitution'],
  [`SUPABASE_PROJECT_REF=${STAGING} env \`cat extra.env\` scripts/check-attribution.sh`, ASK_EVERYWHERE, 'backticks'],
  [`env SUPABASE_PROJECT_REF=${STAGING} $EXTRA scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'the dynamic word after the literal assignment'],
  [`env $EXTRA SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'the dynamic word before the literal assignment'],
  [`SUPABASE_PROJECT_REF=${STAGING} env FOO=1 $EXTRA bash scripts/delete-test-data.sh`, ASK_EVERYWHERE, 'after another assignment, through bash'],
  [`SUPABASE_PROJECT_REF=${STAGING} env X=$EXTRA$MORE "$@" scripts/create-user.sh a@example.com`, ASK_EVERYWHERE, 'the positional parameters'],
]);

table('P0-9 RF-056: env with only literal words keeps the staging allowance', [
  [`env SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, NAMES_STAGING, 'through env, nothing dynamic'],
  [`SUPABASE_PROJECT_REF=${STAGING} env FOO=1 scripts/create-user.sh a@example.com`, NAMES_STAGING, 'a literal assignment between env and the script'],
]);

// ===========================================================================
// P0-10 (written before implementation)
//
// Derived from "P0-10 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// and rows RF-059 and RF-061 of docs/saas/REVIEW_FINDINGS.md. The tables use
// the project tree built for P0-9 (TREE): the root is linked to staging, so a
// remote Supabase call, an e2e run and a test:* script are all allowed there
// (pinned by the fixture test above). Branch names, commits and directories
// are invented; the hook only reads the command, it never runs it.
//
// Existing tests changed for P0-10 (each is marked "RF-061" where it stands):
//   - runCommand now sends `cwd` (the project root);
//   - makeProject now creates e2e/ and e2e/saas/;
//   - six `supabase link` rows in the rule 6 tables now ask in every
//     configuration.
// ===========================================================================

writeFileSync(join(TREE.root, 'e2e', 'rls_e2e.py'), 'print("suite")\n');
mkdirSync(join(TREE.root, 'scripts'), { recursive: true });
writeFileSync(join(TREE.root, 'scripts', 'tool.py'), 'print("tool")\n');

// ---------------------------------------------------------------------------
// RF-059 - a tree-changing git command earlier on the same line
// ---------------------------------------------------------------------------

/** Git commands that can change the working tree or create a checkout. */
const TREE_CHANGING_GIT = [
  ['git checkout main', 'checkout <branch>'],
  ['git checkout 0123abc', 'checkout <sha>'],
  ['git switch main', 'switch <branch>'],
  ['git pull', 'pull'],
  ['git merge x', 'merge'],
  ['git rebase x', 'rebase'],
  ['git reset --hard x', 'reset --hard'],
  ['git stash', 'stash'],
  ['git stash pop', 'stash pop'],
  ['git restore .', 'restore'],
  ['git revert x', 'revert'],
  ['git cherry-pick x', 'cherry-pick'],
  ['git am', 'am'],
  ['git apply', 'apply'],
  ['git bisect start', 'bisect'],
  ['git worktree add d b', 'worktree add'],
  ['git clone . d', 'clone'],
  ['git submodule update', 'submodule'],
];

/** Calls that are allowed at the root of TREE only because the link and the tree are known. */
const NEEDS_KNOWN_TREE = [
  ['supabase db push', 'a Supabase call linked to staging'],
  ['supabase functions deploy x', 'a function deploy linked to staging'],
  ['supabase secrets set A=b', 'a secret set on the linked project'],
  ['python3 e2e/rls_e2e.py', 'an e2e run'],
  ['npm run test:rls', 'a test:* script'],
];

describe('P0-10 RF-059: the fixture is what the tables below assume', () => {
  for (const [call, what] of NEEDS_KNOWN_TREE) {
    it(`allow at the root with nothing before it: ${JSON.stringify(call)} - ${what}`, () => {
      assert.equal(decisionOf(runInTree(call, TREE.root)), ALLOW);
    });
  }
});

treeTable(
  'P0-10 RF-059: after a tree-changing git command and &&, the link and the tree are unknown',
  TREE_CHANGING_GIT.flatMap(([git, gitWhat]) =>
    NEEDS_KNOWN_TREE.map(([call, callWhat]) => ['root', `${git} && ${call}`, ASK, `${gitWhat}, then ${callWhat}`])),
);

{
  const JOINS = [
    [(git, call) => `${git}; ${call}`, ';'],
    [(git, call) => `${git} || ${call}`, '||'],
    [(git, call) => `${git}\n${call}`, 'a newline'],
    [(git, call) => `(${git} && ${call})`, 'inside a subshell'],
    [(git, call) => `bash -c "${git} && ${call}"`, 'inside a bash -c string'],
  ];
  // Every git command with every joiner; the call after it rotates so that
  // each of the five calls meets each joiner.
  treeTable(
    'P0-10 RF-059: the same with ;, ||, a newline, a subshell and bash -c',
    TREE_CHANGING_GIT.flatMap(([git, gitWhat], i) =>
      JOINS.map(([join_, joinWhat], j) => {
        const [call, callWhat] = NEEDS_KNOWN_TREE[(i + j) % NEEDS_KNOWN_TREE.length];
        return ['root', join_(git, call), ASK, `${gitWhat}, ${joinWhat}, then ${callWhat}`];
      })),
  );
}

treeTable('P0-10 RF-059: other shapes of "earlier on the same line"', [
  ['root', '(git checkout main) && npm run test:rls', ASK, 'the checkout alone in a subshell still changes the tree'],
  ['root', '(git pull; supabase db push)', ASK, 'subshell with ;'],
  ['root', 'bash -c "git pull" && supabase db push', ASK, 'the git command alone in a bash -c string'],
  ['root', 'sh -c "git checkout main; python3 e2e/rls_e2e.py"', ASK, 'sh -c string with ;'],
  ['root', 'git checkout main && git status && supabase db push', ASK, 'a harmless command in between'],
  ['root', 'git checkout main; echo done; python3 e2e/rls_e2e.py', ASK, 'two commands later'],
  ['root', 'git stash && npm run lint && git stash pop && npm run test:rls', ASK, 'stash, work, pop, then the suite'],
  ['root', 'git -C . checkout main && supabase db push', ASK, 'git -C <dir> checkout'],
  ['root', 'git --no-pager checkout main && npm run test:rls', ASK, 'a global git flag before the verb'],
  ['root', 'git checkout . && supabase db push', ASK, 'checkout of paths rewrites the tree'],
  ['root', 'git checkout main -- . && npm run test:rls', ASK, "checkout of another branch's files"],
  ['root', 'git checkout -b new && git checkout main && supabase db push', ASK, 'a harmless -b first, then a real checkout'],
  ['root', 'npm run test:rls && git checkout main && npm run test:rls', ASK, 'an allowed run before the checkout does not excuse the one after it'],
  ['root', 'supabase db push && git pull && supabase db push', ASK, 'an allowed push before the pull does not excuse the one after it'],
  ['root', 'git checkout main && cd . && supabase db push', ASK, 'a cd after the checkout does not make the link known again'],
  ['root', `git checkout main && cd ${TREE.root} && npm run test:rls`, ASK, 'cd to the root by absolute path after the checkout'],
  ['root', 'git checkout main && cd "$CLAUDE_PROJECT_DIR" && supabase db push', ASK, 'cd "$CLAUDE_PROJECT_DIR" after the checkout'],
  ['root', `git checkout main && supabase --workdir ${TREE.root} db push`, ASK, '--workdir naming the root after the checkout'],
  ['root', 'git checkout main && cd e2e && python3 rls_e2e.py', ASK, 'cd into e2e/ after the checkout'],
  ['root', 'git checkout main && npm run test:e2e', ASK, 'the umbrella test script'],
  ['root', 'git pull && yarn test:rls', ASK, 'yarn'],
  ['root', 'git pull && python3 -m e2e.x', ASK, 'an e2e module run'],
  ['root', 'git merge x && npx supabase db push', ASK, 'the CLI through npx'],
  ['plain', 'git checkout main && supabase db push', ASK, 'from a plain subdirectory'],
  ['wt', `git checkout main && cd ${TREE.root} && supabase db push`, ASK, 'from the worktree'],
]);

table('P0-10 RF-059: the same in every configuration', [
  ['git checkout main && supabase db push', ASK_EVERYWHERE, 'checkout, then a push'],
  ['git pull; npm run test:rls', ASK_EVERYWHERE, 'pull, then a test:* script'],
  ['git switch main && python3 e2e/rls_e2e.py', ASK_EVERYWHERE, 'switch, then an e2e run'],
  ['git stash pop && supabase functions deploy x', ASK_EVERYWHERE, 'stash pop, then a deploy'],
]);

treeTable(
  'P0-10 RF-059: the same git commands on their own line stay allowed',
  TREE_CHANGING_GIT.map(([git, gitWhat]) => ['root', git, ALLOW, `${gitWhat} alone`]),
);

treeTable('P0-10 RF-059: git checkout -b and git switch -c do not change the tree', [
  ...NEEDS_KNOWN_TREE.flatMap(([call, callWhat]) => [
    ['root', `git checkout -b new && ${call}`, ALLOW, `checkout -b, then ${callWhat}`],
    ['root', `git switch -c new && ${call}`, ALLOW, `switch -c, then ${callWhat}`],
  ]),
  ['root', 'git checkout -b saas/phase-1-tenancy; npm run test:rls', ALLOW, 'a branch name with slashes, ;'],
  ['root', 'git switch --create new && supabase db push', ALLOW, 'the long form of -c'],
]);

treeTable('P0-10 RF-059: git commands that do not change the tree leave the allowance alone', [
  ...NEEDS_KNOWN_TREE.flatMap(([call, callWhat]) => [
    ['root', `git status && ${call}`, ALLOW, `status, then ${callWhat}`],
    ['root', `git add -A && git commit -m x && ${call}`, ALLOW, `add and commit, then ${callWhat}`],
    ['root', `git fetch && ${call}`, ALLOW, `fetch, then ${callWhat}`],
    ['root', `git log --oneline -5 && ${call}`, ALLOW, `log, then ${callWhat}`],
    ['root', `git diff HEAD~1 && ${call}`, ALLOW, `diff, then ${callWhat}`],
  ]),
  ['root', 'git worktree list && supabase db push', ALLOW, 'only `worktree add` creates a checkout'],
  ['root', 'git branch -a && npm run test:rls', ALLOW, 'listing branches'],
  ['root', 'git show HEAD:package.json && npm run test:rls', ALLOW, 'showing a file'],
  ['root', 'git rev-parse HEAD; python3 e2e/rls_e2e.py', ALLOW, 'rev-parse'],
  ['root', 'git commit -m "git checkout main" && npm run test:rls', ALLOW, 'rule 4: the checkout is only a commit message'],
  ['root', 'echo git checkout main && npm run test:rls', ALLOW, 'rule 4: the checkout is only an argument of echo'],
  ['root', 'grep -rn "git pull" docs/ && supabase db push', ALLOW, 'rule 4: a grep pattern'],
  ['root', 'git log --grep "git merge x" && supabase db push', ALLOW, 'rule 4: an argument of git log'],
]);

treeTable('P0-10 RF-059: a call BEFORE the git command is judged as before', [
  ...TREE_CHANGING_GIT.slice(0, 6).flatMap(([git, gitWhat], i) => {
    const [call, callWhat] = NEEDS_KNOWN_TREE[i % NEEDS_KNOWN_TREE.length];
    return [
      ['root', `${call} && ${git}`, ALLOW, `${callWhat}, then ${gitWhat}`],
      ['root', `${call}; ${git}`, ALLOW, `${callWhat}; then ${gitWhat}`],
    ];
  }),
  ['root', 'npm run test:rls && git stash && git stash pop', ALLOW, 'the suite, then stash and pop'],
  ['root', 'supabase db push && git checkout -b next', ALLOW, 'a push, then a new branch'],
]);

treeTable('P0-10 RF-059: what the rule leaves alone after a tree-changing git command', [
  ['root', 'git checkout main && npm run lint', ALLOW, 'the type check is not a test:* script'],
  ['root', 'git checkout main && npm test', ALLOW, 'plain npm test'],
  ['root', 'git pull && npm run build', ALLOW, 'the build'],
  ['root', 'git pull && git status', ALLOW, 'another git command'],
  ['root', 'git stash && git checkout -b new && git stash pop', ALLOW, 'only git commands'],
  ['root', 'git checkout main && supabase start', ALLOW, 'the local stack never depended on the link'],
  ['root', 'git checkout main && supabase db push --help', ALLOW, '--help'],
  ['root', 'git checkout main && python3 -c "print(1)"', ALLOW, 'inline Python is not an e2e run'],
  ['root', 'git checkout main && scripts/gate.sh quick', ALLOW, 'the gate'],
]);

// The criterion names the calls that ask: "a Supabase CLI call that would
// otherwise count as linked to staging, an e2e run and a test:* script". A
// call that names the staging ref itself does not rest on the link file.
treeTable('P0-10 RF-059 (assumed reading): a call that names the staging ref does not depend on the link', [
  ['root', `git checkout main && supabase functions deploy x --project-ref ${STAGING}`, ALLOW, 'F1: the target is on the line, not in the link file'],
]);

// `git checkout -b <new> <start>` and `git switch -c <new> <start>` do check
// out <start>: the working tree changes exactly as with `git checkout <start>`.
// The criterion's exemption reads "`git checkout -b <new>` and
// `git switch -c <new>` do not change the tree", which is only true with no
// start point.
treeTable('P0-10 RF-059 (assumed reading): -b / -c with a start point does change the tree', [
  ['root', 'git checkout -b new main && supabase db push', ASK, 'F2: checkout -b <new> <start>'],
  ['root', 'git checkout -b new origin/main && npm run test:rls', ASK, 'F2: checkout -b <new> <remote branch>'],
  ['root', 'git switch -c new main && python3 e2e/rls_e2e.py', ASK, 'F2: switch -c <new> <start>'],
  ['root', 'git checkout -B new 0123abc && supabase db push', ASK, 'F2: checkout -B <new> <sha>'],
  ['root', 'git switch -C new main && npm run test:rls', ASK, 'F2: switch -C <new> <start>'],
]);

// ---------------------------------------------------------------------------
// RF-061 - directory changes the guard did not follow
// ---------------------------------------------------------------------------

treeTable('P0-10 RF-061: builtin cd, command cd and chdir change the effective directory like cd', [
  ['root', 'builtin cd .claude/worktrees/wt && supabase db push', ASK, 'builtin cd into the worktree'],
  ['root', 'command cd ../other && npm run test:rls', ASK, 'command cd to a sibling checkout'],
  ['root', 'chdir vendor/clone && python3 e2e/x.py', ASK, 'chdir into a nested clone'],
  ['root', 'builtin cd packages/api && supabase functions deploy report', ASK, 'builtin cd into a directory with its own supabase/'],
  ['root', 'command cd src && npm run test:rls', ASK, 'command cd into a plain subdirectory: not the root'],
  ['root', 'chdir .. && supabase db push', ASK, 'chdir out of the project'],
  ['root', `builtin cd ${TREE.other} && python3 e2e/x.py`, ASK, 'builtin cd by absolute path'],
  ['root', 'builtin cd .claude/worktrees/wt; npm run test:rls', ASK, 'builtin cd with ;'],
  ['root', '(command cd ../other && python3 e2e/x.py)', ASK, 'command cd in a subshell'],
  ['root', 'bash -c "builtin cd .claude/worktrees/wt && npm run test:rls"', ASK, 'bash -c string'],
  ['root', 'builtin cd "$TARGET_DIR" && supabase db push', ASK, 'builtin cd to a directory held in a variable'],
  ['root', 'command cd - && npm run test:rls', ASK, 'command cd to the previous directory'],
  // Controls: "like cd" also means a harmless one keeps the allowance.
  ['root', 'builtin cd src/components && supabase db push', ALLOW, 'builtin cd into a plain subdirectory'],
  ['root', 'command cd e2e && python3 x.py', ALLOW, "command cd into this project's e2e/"],
  ['root', 'chdir e2e/saas && python3 y.py', ALLOW, "chdir into a subdirectory of this project's e2e/"],
  ['wt', `builtin cd ${TREE.root} && npm run test:rls`, ALLOW, 'from the worktree, builtin cd to the project root'],
  ['other', `command cd ${TREE.root} && supabase db push`, ALLOW, 'from outside, command cd to the project root'],
  ['plain', 'chdir ../.. && npm run test:rls', ALLOW, 'chdir back up to the root'],
  ['root', 'builtin cd ../other && npm run lint', ALLOW, 'nothing that depends on the directory follows'],
]);

treeTable('P0-10 RF-061: npx/bunx --prefix/--cwd, sudo -D and find -execdir make the directory unknown', [
  ['root', 'npx --prefix ../other supabase db push', ASK, 'npx --prefix'],
  ['root', 'npx --prefix=.claude/worktrees/wt supabase functions deploy report', ASK, 'npx --prefix=<dir>'],
  ['root', 'npx --prefix . supabase db push', ASK, 'unknown, even when the flag names the root'],
  ['root', 'npx --cwd ../other supabase db push', ASK, 'npx --cwd'],
  ['root', 'npx -y --prefix ../other supabase db push', ASK, 'npx --prefix after another flag'],
  ['root', 'npx --prefix ../other npm run test:rls', ASK, 'npx --prefix, then a test:* script'],
  ['root', 'bunx --cwd ../other supabase db push', ASK, 'bunx --cwd'],
  ['root', 'bunx --cwd=vendor/clone supabase secrets set A=b', ASK, 'bunx --cwd=<dir>'],
  ['root', 'bunx --prefix ../other supabase db push', ASK, 'bunx --prefix'],
  ['root', 'sudo -D ../other supabase db push', ASK, 'sudo -D'],
  ['root', 'sudo -D .claude/worktrees/wt npm run test:rls', ASK, 'sudo -D, then a test:* script'],
  ['root', 'sudo -D ../other python3 e2e/x.py', ASK, 'sudo -D, then an e2e run'],
  ['root', 'sudo -u nobody -D ../other supabase db push', ASK, 'sudo -D after another flag'],
  ['root', 'find .. -maxdepth 2 -name package.json -execdir npm run test:rls \\;', ASK, 'find -execdir runs in the directory of each match'],
  ['root', 'find . -name config.toml -execdir supabase db push \\;', ASK, 'find -execdir with the CLI'],
  ['root', 'find ../other -name e2e -execdir python3 e2e/x.py \\;', ASK, 'find -execdir with an e2e run'],
  ['root', 'find . -name config.toml -execdir supabase db push +', ASK, 'find -execdir ... +'],
  ['root', 'bash -c "npx --prefix ../other supabase db push"', ASK, 'bash -c string'],
  // Controls.
  ['root', 'npx supabase db push', ALLOW, 'npx with no directory flag'],
  ['root', 'npx --yes supabase db push', ALLOW, 'npx with another flag'],
  ['root', 'npx --prefix ../other tsc --noEmit', ALLOW, 'nothing that depends on the directory'],
  ['root', 'bunx --cwd ../other eslint .', ALLOW, 'nothing that depends on the directory'],
  ['root', 'sudo -D /tmp ls', ALLOW, 'nothing that depends on the directory'],
  ['root', 'find . -name "*.sql" -execdir ls {} \\;', ALLOW, 'nothing that depends on the directory'],
  ['root', 'find supabase -name "*.sql" && supabase db push', ALLOW, 'a find without -execdir, then the push at the root'],
]);

treeTable('P0-10 RF-061 (assumed reading): the long form of sudo -D', [
  ['root', 'sudo --chdir=../other supabase db push', ASK, 'G1: --chdir=<dir> is -D'],
  ['root', 'sudo --chdir ../other npm run test:rls', ASK, 'G1: --chdir <dir> is -D'],
]);

treeTable('P0-10 RF-061: a cd to a directory that does not exist when the hook runs makes the directory unknown', [
  ['root', 'cd nope && supabase db push', ASK, 'cd into a directory that is not there'],
  ['root', 'cd nope; supabase db push', ASK, 'with ; the push runs wherever the shell is left'],
  ['root', 'cd nope || true; npm run test:rls', ASK, 'the failure is swallowed'],
  ['root', 'cd nope/.. && npm run test:rls', ASK, 'the path only looks like the root: nope does not exist'],
  ['root', 'cd src/nope/../.. && supabase db push', ASK, 'dot segments through a missing directory'],
  ['root', 'cd e2e/nope && python3 x.py', ASK, 'a missing directory below e2e/'],
  ['root', `cd ${TREE.root}/nope && python3 ${TREE.root}/e2e/x.py`, ASK, 'a missing directory by absolute path, then an absolute e2e file'],
  ['root', `cd ${TREE.wrap}/gone && supabase db push`, ASK, 'a missing directory outside the project'],
  ['root', 'cd package.json && supabase db push', ASK, 'the name exists but is a file, not a directory'],
  ['root', 'mkdir -p fresh && cd fresh && supabase db push', ASK, 'made on the same line: not there when the hook runs'],
  ['root', '(cd nope && npm run test:rls)', ASK, 'in a subshell'],
  ['root', 'bash -c "cd nope; python3 e2e/x.py"', ASK, 'bash -c string'],
  ['root', 'builtin cd nope && supabase db push', ASK, 'builtin cd'],
  ['plain', 'cd ../nope && supabase db push', ASK, 'from a subdirectory'],
  // Controls.
  ['root', 'cd src/components && supabase db push', ALLOW, 'a directory that exists'],
  ['root', 'cd e2e && python3 x.py', ALLOW, 'a directory that exists'],
  ['root', 'cd nope && ls', ALLOW, 'nothing that depends on the directory'],
  ['root', 'cd nope && git status', ALLOW, 'nothing that depends on the directory'],
  ['root', 'cd nope && npm run lint', ALLOW, 'nothing that depends on the directory'],
]);

// --- the hook's own cwd -----------------------------------------------------

const NO_CWD = Symbol('no cwd field');

/** Run the hook for one command with the `cwd` field as given (NO_CWD leaves it out); the project is TREE.root. */
function runWithCwdField(command, cwdField) {
  const input = { tool_name: 'Bash', tool_input: { command } };
  if (cwdField !== NO_CWD) input.cwd = cwdField;
  return runRaw(JSON.stringify(input), TREE.root);
}

describe('P0-10 RF-061: a hook cwd that is missing, empty or not absolute is unknown', () => {
  const UNKNOWN = [
    ['no cwd field', NO_CWD],
    ['an empty cwd', ''],
    ['cwd "."', '.'],
    ['cwd "./"', './'],
    ['a relative cwd', 'src/components'],
    ['a relative cwd that names the project folder', 'project'],
    ['cwd ".."', '..'],
    ['cwd "~"', '~'],
    ['a cwd of blanks', '   '],
  ];
  const DEPENDS_ON_DIRECTORY = [
    'supabase db push',
    'supabase functions deploy x',
    'python3 e2e/rls_e2e.py',
    'python3 e2e/x.py',
    'npm run test:rls',
    'cd e2e && python3 x.py',
    'cd src/components && supabase db push',
    'cd . && npm run test:rls',
    'supabase --workdir . db push',
  ];
  for (const [why, cwdField] of UNKNOWN) {
    for (const command of DEPENDS_ON_DIRECTORY) {
      it(`ask [${why}]: ${JSON.stringify(command)}`, () => {
        assert.equal(decisionOf(runWithCwdField(command, cwdField)), ASK, `hook cwd: ${String(cwdField)}`);
      });
    }
  }

  // Controls: the same commands with the root as an absolute cwd.
  for (const command of DEPENDS_ON_DIRECTORY) {
    it(`allow [cwd = the project root, absolute]: ${JSON.stringify(command)}`, () => {
      assert.equal(decisionOf(runWithCwdField(command, TREE.root)), ALLOW);
    });
  }

  // Controls: rules that never depended on the directory give the same answer without a cwd.
  for (const [why, cwdField] of [['no cwd field', NO_CWD], ['an empty cwd', ''], ['cwd "."', '.']]) {
    for (const [command, want] of [
      ['git status', ALLOW],
      ['npm run lint', ALLOW],
      ['npm test', ALLOW],
      ['supabase start', ALLOW],
      ['supabase db push --help', ALLOW],
      ['python3 -c "print(1)"', ALLOW],
      ['git push origin main', DENY],
      [`echo ${PROD}`, ASK],
      [`supabase functions deploy x --project-ref ${STAGING}`, ALLOW],
    ]) {
      it(`${want} [${why}]: ${JSON.stringify(command)} - does not depend on the directory`, () => {
        assert.equal(decisionOf(runWithCwdField(command, cwdField)), want);
      });
    }
  }

  // An unknown start is repaired by a step that names the place absolutely.
  for (const [why, cwdField] of [['no cwd field', NO_CWD], ['an empty cwd', ''], ['a relative cwd', 'src']]) {
    for (const command of [
      `cd ${TREE.root} && supabase db push`,
      `cd ${TREE.root} && npm run test:rls`,
      `cd ${TREE.root}/e2e && python3 x.py`,
      'cd "$CLAUDE_PROJECT_DIR" && npm run test:rls',
      'cd "$CLAUDE_PROJECT_DIR" && python3 e2e/rls_e2e.py',
      'cd "$CLAUDE_PROJECT_DIR" && supabase db push',
      `supabase --workdir ${TREE.root} db push`,
    ]) {
      const shown = command.split(WRAP).join('<wrap>');
      it(`allow [${why}]: ${JSON.stringify(shown)} - the line itself names the project root`, () => {
        assert.equal(decisionOf(runWithCwdField(command, cwdField)), ALLOW);
      });
    }
    it(`ask [${why}]: a cd by absolute path into the worktree is known, and is not this checkout`, () => {
      assert.equal(decisionOf(runWithCwdField(`cd ${TREE.wt} && supabase db push`, cwdField)), ASK);
    });
  }
});

describe('P0-10 RF-061 (assumed reading): a cwd that is not a string is not an absolute path', () => {
  for (const [why, cwdField] of [['null', null], ['a number', 42], ['a list', [TREE.root]], ['an object', { path: TREE.root }], ['true', true]]) {
    for (const command of ['supabase db push', 'python3 e2e/rls_e2e.py', 'npm run test:rls']) {
      it(`never allow [cwd is ${why}]: ${JSON.stringify(command)} - G2`, () => {
        assert.notEqual(decisionOf(runWithCwdField(command, cwdField)), ALLOW);
      });
    }
  }
});

describe('P0-10 RF-061: the old default is gone in every configuration (no cwd is not the root)', () => {
  for (const configName of ALL_CONFIGS) {
    for (const command of ['supabase db push', 'python3 e2e/rls_e2e.py', 'npm run test:rls']) {
      it(`ask [${configName}, no cwd field]: ${JSON.stringify(command)}`, () => {
        const stdin = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
        assert.equal(decisionOf(runRaw(stdin, CONFIGS[configName])), ASK);
      });
    }
  }
});

treeTable('P0-10 RF-061: Python given a relative script while the directory is unknown asks', [
  ['root', 'cd "$TARGET_DIR" && python3 x.py', ASK, 'the finding: a bare file name after cd into an unknown folder'],
  ['root', 'cd "$TARGET_DIR" && python3 rls_e2e.py', ASK, 'a suite name with no e2e/ in front of it'],
  ['root', 'cd "$TARGET_DIR" && python3 scripts/tool.py', ASK, 'a relative path that does not mention e2e'],
  ['root', 'cd "$TARGET_DIR" && python ./x.py', ASK, 'python, ./ path'],
  ['root', 'cd "$TARGET_DIR" && python3 -u tool.py --verbose', ASK, 'a flag before and an argument after'],
  ['root', 'cd $(mktemp -d) && python3 run.py', ASK, 'cd to the output of a command'],
  ['root', 'cd - && python3 tool.py', ASK, 'cd to the previous directory'],
  ['root', 'cd && python3 tool.py', ASK, 'cd with no argument goes to the home directory'],
  ['root', 'cd nope && python3 tool.py', ASK, 'cd to a directory that does not exist'],
  ['root', 'cd nope; python3 scripts/tool.py', ASK, 'cd to a missing directory, ;'],
  ['root', 'sudo -D "$TARGET_DIR" python3 tool.py', ASK, 'sudo -D'],
  ['root', 'find . -name x.py -execdir python3 x.py \\;', ASK, 'find -execdir'],
  ['root', '(cd "$TARGET_DIR" && python3 x.py)', ASK, 'in a subshell'],
  ['root', 'bash -c \'cd "$TARGET_DIR" && python3 x.py\'', ASK, 'bash -c string'],
  ['root', 'builtin cd "$TARGET_DIR" && python3 x.py', ASK, 'builtin cd'],
  // Controls.
  ['root', 'python3 scripts/tool.py', ALLOW, 'a relative script in a known directory'],
  ['root', 'cd src && python3 tool.py', ALLOW, 'a relative script after cd into a known directory, not under e2e/'],
  ['wt', 'python3 scripts/tool.py', ALLOW, 'a known directory, even another checkout: the script is not under e2e/'],
  ['root', 'cd "$TARGET_DIR" && python3 -c "print(1)"', ALLOW, 'inline Python is not a script file'],
  ['root', 'cd "$TARGET_DIR" && python3 --version', ALLOW, 'no script at all'],
  ['root', 'cd "$TARGET_DIR" && python3 -m json.tool data.json', ALLOW, 'a standard-library module, not a script file'],
  ['root', `cd "$TARGET_DIR" && python3 ${TREE.root}/scripts/tool.py`, ALLOW, 'an absolute script that is not under any e2e/'],
  ['root', 'cd "$TARGET_DIR" && ls', ALLOW, 'not Python'],
]);

describe('P0-10 RF-061: Python given a relative script with no usable hook cwd asks', () => {
  for (const [why, cwdField] of [['no cwd field', NO_CWD], ['an empty cwd', ''], ['a relative cwd', 'src']]) {
    for (const command of ['python3 x.py', 'python3 scripts/tool.py', 'python ./tool.py']) {
      it(`ask [${why}]: ${JSON.stringify(command)}`, () => {
        assert.equal(decisionOf(runWithCwdField(command, cwdField)), ASK);
      });
    }
  }
});

treeTable('P0-10 RF-061: a dotted module name with an e2e part anywhere asks under the e2e rule', [
  ['root', 'python3 -m pkg.e2e.x', ASK, 'the finding: e2e is the second part'],
  ['root', 'python3 -m tools.e2e', ASK, 'e2e is the last part'],
  ['root', 'python -m a.b.e2e.c.d', ASK, 'e2e in the middle'],
  ['root', 'python3 -m vendor.clone.e2e.x', ASK, "a nested clone's e2e package"],
  ['root', 'python3 -m packages.api.e2e.x', ASK, 'an e2e folder that is not the one at the project root'],
  ['root', 'python3 -m unittest pkg.e2e.x', ASK, 'unittest with e2e as the second part'],
  ['root', 'python3 -m unittest -v other.e2e.test_x', ASK, 'unittest with a flag first'],
  ['root', 'python3 -m unittest e2e.x pkg.e2e.x', ASK, 'an allowed module does not excuse the one after it'],
  ['root', 'python3 -m pytest vendor.e2e.x', ASK, 'pytest with e2e as the second part'],
  ['root', 'python3 -u -m pkg.e2e.x', ASK, 'an interpreter flag before -m'],
  ['root', 'bash -c "python3 -m pkg.e2e.x"', ASK, 'bash -c string'],
  ['root', 'cd src && python3 -m pkg.e2e.x', ASK, 'after cd'],
  // Controls.
  ['root', 'python3 -m e2e.x', ALLOW, "this project's own e2e package at the root"],
  ['root', 'python3 -m e2e.saas.y', ALLOW, "a subpackage of this project's own e2e"],
  ['root', 'python3 -m json.tool package.json', ALLOW, 'no e2e part'],
  ['root', 'python3 -m http.server 8000', ALLOW, 'no e2e part'],
  ['root', 'python3 -m pkg.e2extra.x', ALLOW, 'a part that only starts with e2e'],
  ['root', 'python3 -m pkg.pre2e.x', ALLOW, 'a part that only ends with e2e'],
  ['root', 'python3 -m pkg.e2e_helpers.x', ALLOW, 'a part that only starts with e2e_'],
  ['root', 'python3 -m unittest pkg.tests.x', ALLOW, 'unittest with no e2e part'],
]);

table('P0-10 RF-061: a module with an e2e part that is not first asks in every configuration', [
  ['python3 -m pkg.e2e.x', ASK_EVERYWHERE, 'e2e is the second part'],
  ['python3 -m unittest pkg.e2e.x', ASK_EVERYWHERE, 'unittest'],
]);

treeTable('P0-10 RF-061: npm_config_* in front of a test:* run asks', [
  ['root', 'npm_config_prefix=../other npm run test:rls', ASK, 'the prefix moves npm to another package'],
  ['root', 'npm_config_local_prefix=.claude/worktrees/wt npm run test:rls', ASK, 'local prefix'],
  ['root', 'npm_config_prefix=. npm run test:rls', ASK, 'even when it names the root: any npm_config_* asks'],
  ['root', 'npm_config_script_shell=/tmp/sh npm run test:e2e', ASK, 'the shell the script runs in'],
  ['root', 'npm_config_ignore_scripts=false npm run test:rls', ASK, 'any npm_config_* variable'],
  ['root', 'npm_config_prefix="$TARGET_DIR" npm run test:rls', ASK, 'a value held in a variable'],
  ['root', 'CI=1 npm_config_prefix=../other npm run test:rls', ASK, 'after another assignment'],
  ['root', 'env npm_config_prefix=../other npm run test:rls', ASK, 'through env'],
  ['root', 'npm_config_prefix=../other npm run-script test:rls', ASK, 'npm run-script'],
  ['root', 'npm_config_prefix=../other npm --silent run test:rls', ASK, 'a flag before run'],
  ['root', 'bash -c "npm_config_prefix=../other npm run test:rls"', ASK, 'bash -c string'],
  ['root', 'npm test && npm_config_prefix=../other npm run test:rls', ASK, 'after &&'],
  // Controls.
  ['root', 'CI=1 npm run test:rls', ALLOW, 'another variable in front'],
  ['root', 'NODE_ENV=test npm run test:rls', ALLOW, 'another variable in front'],
  ['root', 'npm_configx=1 npm run test:rls', ALLOW, 'a name that only starts like it'],
  ['root', 'npm_config_loglevel=silent npm run lint', ALLOW, 'not a test:* script'],
  ['root', 'npm_config_prefix=../other npm run build', ALLOW, 'not a test:* script'],
  ['root', 'echo npm_config_prefix=../other && npm run test:rls', ALLOW, 'rule 4: an argument of echo, not an assignment'],
]);

treeTable('P0-10 RF-061 (assumed reading): other ways to put npm_config_* in front of the run', [
  ['root', 'export npm_config_prefix=../other; npm run test:rls', ASK, 'G3: exported earlier on the line'],
  ['root', 'export npm_config_prefix=../other && npm run test:rls', ASK, 'G3: exported earlier on the line, &&'],
  ['root', 'NPM_CONFIG_PREFIX=../other npm run test:rls', ASK, 'G4: npm reads the upper-case name too'],
]);

table('P0-10 RF-061: supabase link and unlink always ask', [
  ['supabase link', ASK_EVERYWHERE, 'link with no ref named'],
  ['supabase unlink', ASK_EVERYWHERE, 'the finding: unlink from the root'],
  [`supabase link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'link to staging'],
  [`supabase link --project-ref=${STAGING}`, ASK_EVERYWHERE, 'link to staging, = form'],
  [`supabase link --project-ref ${OTHER}`, ASK_EVERYWHERE, 'link to a third project'],
  [`supabase link --project-ref ${STAGING} --password "$DB_PASSWORD"`, ASK_EVERYWHERE, 'link with a password'],
  ['supabase --debug unlink', ASK_EVERYWHERE, 'global flag before the verb'],
  [`supabase --workdir . link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'global flag with a value'],
  ['npx supabase unlink', ASK_EVERYWHERE, 'through npx'],
  [`npx -y supabase@latest link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'through npx with a version'],
  ['./node_modules/.bin/supabase unlink', ASK_EVERYWHERE, 'by path'],
  [`cd supabase && supabase link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'cd then run'],
  [`SUPABASE_ACCESS_TOKEN=$TOKEN supabase link --project-ref ${STAGING}`, ASK_EVERYWHERE, 'environment assignment first'],
  ['bash -c "supabase unlink"', ASK_EVERYWHERE, 'bash -c string'],
  [`eval "supabase link --project-ref ${STAGING}"`, ASK_EVERYWHERE, 'eval string'],
  ['(supabase link)', ASK_EVERYWHERE, 'subshell'],
  ['echo y | supabase unlink', ASK_EVERYWHERE, 'piped confirmation'],
  ['supabase unlink --yes', ASK_EVERYWHERE, 'confirmed in advance'],
  ['supabase link --version', ASK_EVERYWHERE, 'RF-056: --version excuses nothing'],
  ['supabase db push && supabase unlink', ASK_EVERYWHERE, 'after a call that staging would allow'],
  ['supabase unlink; echo --help', ASK_EVERYWHERE, 'the --help belongs to another command'],
]);

table('P0-10 RF-061: what the link rule leaves alone', [
  ['supabase link --help', ALLOW, '--help'],
  ['supabase unlink -h', ALLOW, '-h'],
  ['supabase migration new link_tables', ALLOW, 'a local migration file with link in its name'],
  ['git commit -m "supabase link and unlink now ask"', ALLOW, 'rule 4: a mention'],
  ['grep -rn "supabase unlink" docs/', ALLOW, 'rule 4: a grep pattern'],
  ['unlink notes.tmp', ALLOW, 'the shell command unlink is not the Supabase CLI'],
], ALL_CONFIGS);

table('P0-10 RF-061: other calls that name the staging ref keep their allowance', [
  [`supabase functions deploy report --project-ref ${STAGING}`, NAMES_STAGING, 'a deploy naming staging'],
  [`supabase secrets list --project-ref ${STAGING}`, NAMES_STAGING, 'a read naming staging'],
]);

// --- cd "$CLAUDE_PROJECT_DIR" ------------------------------------------------

table('P0-10 RF-061: a literal cd "$CLAUDE_PROJECT_DIR" counts as the project root', [
  ['cd "$CLAUDE_PROJECT_DIR" && npm run test:rls', STAGING_SET, 'then a test:* script'],
  ['cd "$CLAUDE_PROJECT_DIR" && python3 e2e/rls_e2e.py', STAGING_SET, 'then an e2e run'],
  ['cd "$CLAUDE_PROJECT_DIR" && supabase db push', LINK_DECIDES, 'then a push: the link still decides'],
  ['cd "$CLAUDE_PROJECT_DIR" && supabase functions deploy report', LINK_DECIDES, 'then a deploy: the link still decides'],
]);

treeTable('P0-10 RF-061: cd "$CLAUDE_PROJECT_DIR" from anywhere', [
  ['root', 'cd "$CLAUDE_PROJECT_DIR" && npm run test:rls', ALLOW, 'from the root'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR" && python3 e2e/rls_e2e.py', ALLOW, 'from the root'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR" && supabase db push', ALLOW, 'from the root'],
  ['plain', 'cd "$CLAUDE_PROJECT_DIR" && npm run test:rls', ALLOW, 'from a plain subdirectory'],
  ['wt', 'cd "$CLAUDE_PROJECT_DIR" && supabase db push', ALLOW, 'from the worktree'],
  ['wt', 'cd "$CLAUDE_PROJECT_DIR" && npm run test:rls', ALLOW, 'from the worktree'],
  ['other', 'cd "$CLAUDE_PROJECT_DIR" && python3 e2e/x.py', ALLOW, 'from outside the project'],
  ['clone', 'cd "$CLAUDE_PROJECT_DIR" && supabase functions deploy report', ALLOW, 'from a nested clone'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR"; npm run test:rls', ALLOW, 'with ;'],
  ['plain', '(cd "$CLAUDE_PROJECT_DIR" && python3 e2e/x.py)', ALLOW, 'in a subshell'],
  ['other', 'cd "$CLAUDE_PROJECT_DIR" && cd e2e && python3 x.py', ALLOW, 'then a relative cd into e2e/'],
  ['wt', 'cd "$CLAUDE_PROJECT_DIR" && cd src/components && supabase db push', ALLOW, 'then a relative cd into a plain subdirectory'],
  ['wt', 'cd "$CLAUDE_PROJECT_DIR" && scripts/gate.sh quick && npm run test:rls', ALLOW, 'the everyday line: the gate, then a suite'],
  // Negative controls: no other variable, and nothing glued to this one.
  ['root', 'cd "$OTHER" && npm run test:rls', ASK, 'another variable'],
  ['root', 'cd "$OTHER" && python3 e2e/rls_e2e.py', ASK, 'another variable'],
  ['root', 'cd "$OTHER" && supabase db push', ASK, 'another variable'],
  ['root', 'cd "$CLAUDE_PROJECT_DIRX" && supabase db push', ASK, 'a longer variable name'],
  ['root', 'cd "$CLAUDE_PROJECT" && npm run test:rls', ASK, 'a shorter variable name'],
  ['root', 'cd "$MY_CLAUDE_PROJECT_DIR" && npm run test:rls', ASK, 'a name that only ends like it'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR$SUFFIX" && supabase db push', ASK, 'another variable glued on'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR/.claude/worktrees/wt" && supabase db push', ASK, 'a path below it that is a worktree'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR/../other" && npm run test:rls', ASK, 'a path that leaves the project'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR/src" && npm run test:rls', ASK, 'a plain subdirectory is not the root'],
  ['root', 'cd "$HOME" && supabase db push', ASK, 'the home directory'],
  ['wt', 'cd "$PWD" && supabase db push', ASK, 'the current directory through a variable'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR" && cd .claude/worktrees/wt && supabase db push', ASK, 'then a cd into the worktree'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR" && cd "$OTHER" && npm run test:rls', ASK, 'then a cd through another variable'],
  ['root', 'cd "$CLAUDE_PROJECT_DIR" && cd .. && supabase db push', ASK, 'then a cd out of the project'],
  ['root', "cd '$CLAUDE_PROJECT_DIR' && supabase db push", ASK, 'single quotes: a directory literally named $CLAUDE_PROJECT_DIR'],
]);

// The variable counts as the root because the hook knows its value. A line
// that sets it first has made it mean something else.
treeTable('P0-10 RF-061 (assumed reading): CLAUDE_PROJECT_DIR reassigned on the same line is not the root', [
  ['root', 'CLAUDE_PROJECT_DIR=../other; cd "$CLAUDE_PROJECT_DIR" && npm run test:rls', ASK, 'G5: assigned first, ;'],
  ['root', 'CLAUDE_PROJECT_DIR=../other && cd "$CLAUDE_PROJECT_DIR" && supabase db push', ASK, 'G5: assigned first, &&'],
  ['root', `export CLAUDE_PROJECT_DIR=${TREE.other}; cd "$CLAUDE_PROJECT_DIR" && python3 e2e/x.py`, ASK, 'G5: exported first'],
  ['root', 'CLAUDE_PROJECT_DIR=$(mktemp -d); cd "$CLAUDE_PROJECT_DIR" && supabase db push', ASK, 'G5: assigned from a command'],
]);

// ===========================================================================
// P0-11 (written while the Developer worked on the same task)
//
// Derived from "P0-11 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// and rows RF-063 and RF-065 of docs/saas/REVIEW_FINDINGS.md. Same fixture as
// P0-10: the root of TREE is linked to staging and every hook cwd is absolute.
// Pull-request numbers, repositories and branches are invented.
// ===========================================================================

/** The three kinds of call the criterion names: a Supabase call that rests on the link, an e2e run, a test:* script. */
const P011_CALLS = [
  ['supabase db push', 'a Supabase call that rests on the staging link'],
  ['python3 e2e/rls_e2e.py', 'an e2e run'],
  ['npm run test:sync', 'a test:* script'],
];

// ---------------------------------------------------------------------------
// RF-063 - the GitHub CLI and hub change the tree exactly like git
// ---------------------------------------------------------------------------

/** GitHub CLI and hub commands that check out, clone or pull. */
const TREE_CHANGING_GH = [
  ['gh pr checkout 5', 'gh pr checkout'],
  ['gh pr checkout 5 --force', 'gh pr checkout --force'],
  ['gh pr co 5', 'gh pr co, the alias of checkout'],
  ['gh repo clone o/r', 'gh repo clone'],
  ['gh repo sync', 'gh repo sync'],
  ['gh repo fork --clone', 'gh repo fork --clone'],
  ['hub checkout main', 'hub checkout'],
  ['hub pull', 'hub pull'],
  ['hub pr checkout 5', 'hub pr checkout'],
  ['hub sync', 'hub sync'],
];

/** GitHub CLI commands that only read or talk to GitHub. */
const HARMLESS_GH = [
  ['gh pr view 5', 'gh pr view'],
  ['gh pr checks 5', 'gh pr checks'],
  ['gh pr create --title t --body b', 'gh pr create'],
  ['gh run watch', 'gh run watch'],
];

describe('P0-11 RF-063: the fixture is what the tables below assume', () => {
  for (const [call, what] of P011_CALLS) {
    it(`allow at the root with nothing before it: ${JSON.stringify(call)} - ${what}`, () => {
      assert.equal(decisionOf(runInTree(call, TREE.root)), ALLOW);
    });
  }
});

treeTable(
  'P0-11 RF-063: after a GitHub CLI or hub command that changes the tree, && or ;, the three calls ask',
  TREE_CHANGING_GH.flatMap(([gh, ghWhat]) =>
    P011_CALLS.flatMap(([call, callWhat]) => [
      ['root', `${gh} && ${call}`, ASK, `${ghWhat}, &&, then ${callWhat}`],
      ['root', `${gh}; ${call}`, ASK, `${ghWhat}, ;, then ${callWhat}`],
    ])),
);

treeTable(
  'P0-11 RF-063: the same commands alone are allowed',
  TREE_CHANGING_GH.map(([gh, ghWhat]) => ['root', gh, ALLOW, `${ghWhat} alone`]),
);

treeTable(
  'P0-11 RF-063: gh pr view, checks, create and gh run watch do not count',
  HARMLESS_GH.flatMap(([gh, ghWhat]) => [
    ['root', gh, ALLOW, `${ghWhat} alone`],
    ...P011_CALLS.map(([call, callWhat]) => ['root', `${gh} && ${call}`, ALLOW, `${ghWhat}, then ${callWhat}`]),
  ]),
);

treeTable('P0-11 RF-063: other shapes, and what the rule leaves alone', [
  ['root', 'gh pr checkout 5 && git status && supabase db push', ASK, 'a harmless command in between'],
  ['root', 'gh pr view 5 && gh pr checkout 5 && npm run test:sync', ASK, 'a harmless gh call first, then the checkout'],
  ['root', 'npm run test:sync && gh pr checkout 5', ALLOW, 'the suite BEFORE the checkout is judged as before'],
  ['root', 'gh pr checkout 5 && npm run lint', ALLOW, 'the type check is not a test:* script'],
  // Changed for P0-12 RF-066. Before: ALLOW, 'a fork without --clone creates no
  // checkout'. Now every gh invocation is tree-changing unless its subcommand
  // is on the known-safe list, and of `gh repo` only view and list are on it.
  ['root', 'gh repo fork && npm run test:sync', ASK, 'P0-12 RF-066: gh repo fork is not on the known-safe list'],
  ['root', 'echo gh pr checkout 5 && npm run test:sync', ALLOW, 'rule 4: the checkout is only an argument of echo'],
]);

// ---------------------------------------------------------------------------
// RF-065 - a word naming a path under supabase/.temp earlier on the line
//
// "When any word on the line names a path under supabase/.temp (a write,
// copy, move, link, redirect target or `git show ... >` into it), a Supabase
// call that rests on the link later on the same line asks." The rule pinned
// is the simplest one: any word naming the path, so a read asks as well.
// What each write returns on its own is not pinned here (supabase/.temp is a
// protected path under other rules).
// ---------------------------------------------------------------------------

const LINK_WORDS = [
  ['cp x supabase/.temp/project-ref', 'a copy onto the link file'],
  ['echo ref > supabase/.temp/project-ref', 'a redirect into the link file'],
  ['mv a supabase/.temp/project-ref', 'a move onto the link file'],
  ['ln -sf a supabase/.temp/project-ref', 'a symbolic link in its place'],
  ['tee supabase/.temp/project-ref', 'tee'],
  ["sed -i '' s/a/b/ supabase/.temp/project-ref", 'an in-place edit'],
  ['git show main:supabase/.temp/project-ref > supabase/.temp/project-ref', "git show of another branch's link, redirected into the link file"],
  ['rm -rf supabase/.temp', 'removal of the directory itself'],
  ['cat supabase/.temp/project-ref', 'a read: any word naming the path counts'],
];

treeTable(
  'P0-11 RF-065: a word naming a path under supabase/.temp, then a Supabase call that rests on the link, asks',
  LINK_WORDS.flatMap(([first, what]) => [
    ['root', `${first} && supabase db push`, ASK, `${what}, &&, then a push`],
    ['root', `${first}; supabase db push`, ASK, `${what}, ;, then a push`],
  ]),
);

treeTable('P0-11 RF-065: other spellings of the path, and other calls that rest on the link', [
  ['root', 'cp x ./supabase/.temp/project-ref && supabase db push', ASK, 'a leading ./'],
  ['root', `cp x ${TREE.root}/supabase/.temp/project-ref && supabase db push`, ASK, 'the absolute path'],
  ['root', 'echo ref >supabase/.temp/project-ref && supabase db push', ASK, 'a redirect with no space'],
  ['root', 'cp x "supabase/.temp/project-ref" && supabase db push', ASK, 'the path in quotes'],
  ['root', 'cp x supabase/.temp/project-ref && supabase functions deploy x', ASK, 'a function deploy rests on the link too'],
  ['root', 'cp x supabase/.temp/project-ref && git status && supabase db push', ASK, 'a harmless command in between'],
]);

treeTable('P0-11 RF-065: what the rule leaves alone', [
  ['root', 'ls supabase/migrations && supabase db push', ALLOW, 'another path under supabase/ is not the link'],
  ['root', 'cat supabase/config.toml && supabase db push', ALLOW, 'the config file is not under .temp'],
  ['root', 'ls supabase && supabase db push', ALLOW, 'the supabase directory itself'],
  ['root', 'supabase db push', ALLOW, 'control: the push alone'],
]);

// ===========================================================================
// P0-12 (written before the implementation)
//
// Derived from the P0-12 brief: rows RF-066 and RF-068 of the seventh security
// review. Same fixture as P0-10 and P0-11: the root of TREE is linked to
// staging and every hook cwd is absolute. Numbers, repositories, branches and
// extension names are invented.
// ===========================================================================

/** [join function, name]: the three joiners the brief names. */
const P012_JOINS = [
  [(first, call) => `${first} && ${call}`, '&&'],
  [(first, call) => `${first}; ${call}`, ';'],
  [(first, call) => `${first}\n${call}`, 'a newline'],
];

/** Every first command with every joiner and every call: all ask. */
const p012AskRows = (firsts, calls) =>
  firsts.flatMap(([first, firstWhat]) =>
    P012_JOINS.flatMap(([join_, joinWhat]) =>
      calls.map(([call, callWhat]) => ['root', join_(first, call), ASK, `${firstWhat}, ${joinWhat}, then ${callWhat}`])));

// ---------------------------------------------------------------------------
// RF-066 - every gh invocation is tree-changing unless its subcommand is on
// the list of ones that cannot change the working tree
// ---------------------------------------------------------------------------

/** gh invocations whose subcommand is NOT on the known-safe list. */
const P012_TREE_CHANGING_GH = [
  ['gh co 5', 'gh co, an alias of pr checkout'],
  ['gh issue develop 12 --checkout', 'gh issue develop --checkout'],
  ['gh issue develop 12 -c', 'gh issue develop -c'],
  ['gh issue develop 12', 'gh issue develop without a checkout flag (strict)'],
  ['gh mycheckout 5', 'an unknown top-level word (an alias or an extension)'],
  ["gh alias set co 'pr checkout'", 'gh alias set'],
  ['gh extension exec foo', 'gh extension exec'],
  ['gh codespace ssh', 'gh codespace'],
  ['gh repo fork', 'gh repo fork: of gh repo only view and list are known-safe'],
  ['gh repo create r --clone', 'gh repo create --clone'],
  // The P0-11 ones keep working.
  ['gh pr checkout 5', 'P0-11: gh pr checkout'],
  ['gh pr checkout 5 --force', 'P0-11: gh pr checkout --force'],
  ['gh pr co 5', 'P0-11: gh pr co'],
  ['gh repo clone o/r', 'P0-11: gh repo clone'],
  ['gh repo sync', 'P0-11: gh repo sync'],
  ['gh repo fork --clone', 'P0-11: gh repo fork --clone'],
  // Global flags before the subcommand must not hide it.
  ['gh -R owner/repo co 5', 'a global flag and its value before co'],
  ['gh -R owner/repo pr checkout 5', 'a global flag and its value before pr checkout'],
  ['gh -R owner/repo issue develop 12 -c', 'a global flag and its value before issue develop'],
  // P0-13 RF-069 (written before the implementation). -d / --delete-branch
  // can switch to the default branch, so gh pr close in any form is not
  // known-safe.
  ['gh pr close 5', 'P0-13 RF-069: gh pr close'],
  ['gh pr close 5 -d', 'P0-13 RF-069: gh pr close -d'],
  ['gh pr close 5 --delete-branch', 'P0-13 RF-069: gh pr close --delete-branch'],
  ['gh pr close --delete-branch 5', 'P0-13 RF-069: gh pr close with --delete-branch before the number'],
];

/** gh invocations whose subcommand is on the known-safe list. */
const P012_SAFE_GH = [
  ['gh pr view 5', 'gh pr view'],
  ['gh pr list', 'gh pr list'],
  ['gh pr checks 5', 'gh pr checks'],
  ['gh pr create --fill', 'gh pr create'],
  ['gh pr status', 'gh pr status'],
  ['gh pr diff 5', 'gh pr diff'],
  ['gh pr comment 5 --body hi', 'gh pr comment'],
  ['gh pr edit 5 --title t', 'gh pr edit'],
  ['gh pr ready 5', 'gh pr ready'],
  ['gh pr review 5 --comment --body hi', 'gh pr review'],
  // Changed for P0-13 RF-069, a requirement change: `gh pr close 5` was a row
  // here (ALLOW alone and before each of the three calls). It is now in
  // P012_TREE_CHANGING_GH above, because gh pr close is no longer known-safe.
  ['gh pr reopen 5', 'gh pr reopen'],
  ['gh issue view 12', 'gh issue view'],
  ['gh issue list', 'gh issue list'],
  ['gh issue create --title t --body b', 'gh issue create'],
  ['gh issue comment 12 --body hi', 'gh issue comment'],
  ['gh issue close 12', 'gh issue close'],
  ['gh run list', 'gh run list'],
  ['gh run view 1', 'gh run view'],
  ['gh run watch', 'gh run watch'],
  ['gh workflow list', 'gh workflow list'],
  ['gh workflow view ci.yml', 'gh workflow view'],
  ['gh api repos/owner/repo/pulls', 'gh api (a GET)'],
  ['gh auth status', 'gh auth status'],
  ['gh secret list', 'gh secret list'],
  ['gh variable list', 'gh variable list'],
  ['gh search prs guard', 'gh search'],
  ['gh status', 'gh status'],
  ['gh browse', 'gh browse'],
  ['gh label list', 'gh label list'],
  ['gh release list', 'gh release list'],
  ['gh release view v1', 'gh release view'],
  ['gh cache list', 'gh cache list'],
  ['gh repo view', 'gh repo view'],
  ['gh repo list', 'gh repo list'],
  ['gh --version', 'gh --version'],
  ['gh help', 'gh help'],
];

treeTable(
  'P0-12 RF-066: after a gh invocation that is not on the known-safe list, &&, ; or a newline, the three calls ask',
  p012AskRows(P012_TREE_CHANGING_GH, P011_CALLS),
);

treeTable(
  'P0-12 RF-066: the same gh invocations alone are allowed (not denied, not asked)',
  P012_TREE_CHANGING_GH.map(([gh, ghWhat]) => ['root', gh, ALLOW, `${ghWhat} alone`]),
);

treeTable(
  'P0-12 RF-066: a known-safe gh invocation alone and before each of the three calls is allowed',
  P012_SAFE_GH.flatMap(([gh, ghWhat]) => [
    ['root', gh, ALLOW, `${ghWhat} alone`],
    ...P011_CALLS.map(([call, callWhat]) => ['root', `${gh} && ${call}`, ALLOW, `${ghWhat}, then ${callWhat}`]),
  ]),
);

treeTable('P0-12 RF-066: other shapes, and what the rule leaves alone', [
  ['root', 'gh co 5 && git status && supabase db push', ASK, 'a harmless command in between'],
  ['root', 'gh pr view 5 && gh co 5 && npm run test:sync', ASK, 'a known-safe gh call first, then the alias'],
  ['root', 'gh pr view 5; gh issue develop 12 -c; python3 e2e/rls_e2e.py', ASK, 'a known-safe gh call first, then issue develop'],
  ['root', '(gh co 5) && npm run test:sync', ASK, 'the alias alone in a subshell'],
  ['root', 'bash -c "gh co 5 && supabase db push"', ASK, 'inside a bash -c string'],
  ['root', 'gh issue develop-x 12 && npm run test:sync', ALLOW, 'gh issue with anything except exactly develop is known-safe'],
  ['root', 'npm run test:sync && gh co 5', ALLOW, 'the suite BEFORE the gh call is judged as before'],
  ['root', 'gh co 5 && npm run lint', ALLOW, 'the type check is not a test:* script'],
  ['root', 'echo gh co 5 && npm run test:sync', ALLOW, 'rule 4: the gh call is only an argument of echo'],
  ['root', 'git commit -m "gh co 5" && npm run test:sync', ALLOW, 'rule 4: the gh call is only text in a commit message'],
]);

// "Global flags before the subcommand must not hide it." Assumed reading for
// the rows the brief does not spell out: the long form of the flag counts the
// same, a flag value that happens to be a known-safe word is not the
// subcommand, and a known-safe subcommand behind a global flag stays safe.
treeTable('P0-12 RF-066 (assumed reading): global flags before the subcommand', [
  ['root', 'gh --repo owner/repo co 5 && supabase db push', ASK, 'the long form of -R'],
  ['root', 'gh --repo=owner/repo co 5 && npm run test:sync', ASK, 'the long form with ='],
  ['root', 'gh -R api co 5 && supabase db push', ASK, 'a flag value that is itself a known-safe word does not make co safe'],
  ['root', 'gh -R status co 5; python3 e2e/rls_e2e.py', ASK, 'a flag value that is itself a known-safe word does not make co safe'],
  ['root', 'gh -R owner/repo pr view 5 && npm run test:sync', ALLOW, 'a known-safe subcommand behind a global flag stays safe'],
]);

// ---------------------------------------------------------------------------
// RF-066 extension - a management script after a tree-changing command
//
// An older branch's copy of the script defaults to production, so the staging
// prefix proves nothing once the tree may have changed on the same line.
// ---------------------------------------------------------------------------

const P012_MGMT_CALLS = [
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, 'create-user.sh with the staging prefix'],
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh`, 'delete-test-data.sh with the staging prefix'],
  [`SUPABASE_PROJECT_REF=${STAGING} scripts/check-attribution.sh`, 'check-attribution.sh with the staging prefix'],
];

describe('P0-12 RF-066 extension: the fixture is what the tables below assume', () => {
  for (const [call, what] of P012_MGMT_CALLS) {
    it(`allow at the root with nothing before it: ${what}`, () => {
      assert.equal(decisionOf(runInTree(call, TREE.root)), ALLOW);
    });
  }
});

treeTable(
  'P0-12 RF-066 extension: after a tree-changing git command, a management script with the staging prefix asks',
  p012AskRows(TREE_CHANGING_GIT, P012_MGMT_CALLS),
);

treeTable(
  'P0-12 RF-066 extension: after a tree-changing gh or hub command, a management script with the staging prefix asks',
  p012AskRows([...P012_TREE_CHANGING_GH, ...TREE_CHANGING_GH.filter(([cmd]) => cmd.startsWith('hub '))], P012_MGMT_CALLS),
);

treeTable('P0-12 RF-066 extension: other shapes, and what the rule leaves alone', [
  ['root', `git checkout main && git status && SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh`, ASK, 'a harmless command in between'],
  ['root', `git pull && SUPABASE_PROJECT_REF=${STAGING} bash scripts/create-user.sh a@example.com`, ASK, 'the script through bash'],
  ['root', `git pull && env SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, ASK, 'the prefix through env'],
  ['root', `gh co 5 && cd scripts && SUPABASE_PROJECT_REF=${STAGING} ./check-attribution.sh`, ASK, 'cd into scripts, then run'],
  ['root', `(git switch main) && SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh`, ASK, 'the switch alone in a subshell'],
  ['root', `git status && SUPABASE_PROJECT_REF=${STAGING} scripts/create-user.sh a@example.com`, ALLOW, 'git status does not change the tree'],
  ['root', `gh pr view 5 && SUPABASE_PROJECT_REF=${STAGING} scripts/delete-test-data.sh`, ALLOW, 'a known-safe gh call does not change the tree'],
  ['root', `SUPABASE_PROJECT_REF=${STAGING} scripts/check-attribution.sh && git checkout main`, ALLOW, 'the script BEFORE the checkout is judged as before'],
]);

// ---------------------------------------------------------------------------
// RF-068 - three more git commands that change the tree
// ---------------------------------------------------------------------------

const P012_TREE_CHANGING_GIT = [
  ['git read-tree -um main', 'read-tree -um'],
  ['git checkout-index -a -f', 'checkout-index -a -f'],
  ['git sparse-checkout set x', 'sparse-checkout set'],
];

treeTable(
  'P0-12 RF-068: after read-tree, checkout-index or sparse-checkout, &&, ; or a newline, the three calls ask',
  p012AskRows(P012_TREE_CHANGING_GIT, P011_CALLS),
);

treeTable(
  'P0-12 RF-068: the same three git commands alone are allowed (not denied, not asked)',
  P012_TREE_CHANGING_GIT.map(([git, gitWhat]) => ['root', git, ALLOW, `${gitWhat} alone`]),
);

treeTable(
  'P0-12 RF-068 and RF-066 extension: after the same three git commands a management script asks',
  p012AskRows(P012_TREE_CHANGING_GIT, P012_MGMT_CALLS),
);

// ---------------------------------------------------------------------------
// RF-068 - a word with supabase/ followed anywhere by a brace or glob
// character counts as naming the link directory
// ---------------------------------------------------------------------------

const P012_LINK_PATTERNS = [
  ['cp x supabase/.{temp,foo}/project-ref', 'a brace list that expands to .temp'],
  ['cp x supabase/.tem{p,}/project-ref', 'a brace list that completes .temp'],
  ['cp x supabase/.t*/project-ref', 'a * that matches .temp'],
  ['cp x supabase/.tem?/project-ref', 'a ? that matches .temp'],
  ['cp x supabase/.[t]emp/project-ref', 'a [ ] class that matches .temp'],
  ['cp x supabase/*/project-ref', 'a * for the whole directory name'],
  ['cp x ./supabase/.t*/project-ref', 'a leading ./'],
  ['echo ref > supabase/.tem?/project-ref', 'a redirect target'],
];

treeTable(
  'P0-12 RF-068: supabase/ followed by a brace or glob character, then a Supabase call that rests on the link, asks',
  [
    ...P012_LINK_PATTERNS.flatMap(([first, what]) =>
      P012_JOINS.map(([join_, joinWhat]) => ['root', join_(first, 'supabase db push'), ASK, `${what}, ${joinWhat}, then a push`])),
    ['root', 'cp x supabase/.t*/project-ref && supabase functions deploy x', ASK, 'a function deploy rests on the link too'],
    ['root', 'cp x supabase/.t*/project-ref && git status && supabase db push', ASK, 'a harmless command in between'],
    // Accepted over-ask: the rule is about the word, not about what it matches.
    ['root', 'ls supabase/migrations/*.sql && supabase db push', ASK, 'accepted over-ask: a glob under supabase/migrations'],
  ],
);

treeTable('P0-12 RF-068: what the brace and glob rule leaves alone', [
  ['root', 'ls supabase/migrations && supabase db push', ALLOW, 'no brace or glob character in the word'],
  ['root', 'ls src/*.ts && supabase db push', ALLOW, 'a glob in a word without supabase/'],
  ['root', 'ls *.sql supabase/migrations && supabase db push', ALLOW, 'the glob is in another word'],
  ['root', 'supabase db push && ls supabase/migrations/*.sql', ALLOW, 'the push BEFORE the word is judged as before'],
]);
