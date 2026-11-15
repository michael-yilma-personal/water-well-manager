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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Build a project directory. `link` is the content of supabase/.temp/project-ref, or null for no file. */
function makeProject({ prod = PROD, staging = '', link = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-bash-test-'));
  TEMP_DIRS.push(dir);
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'hooks', 'guard.conf'), `PROD_REF=${prod}\nSTAGING_REF=${staging}\n`);
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

/** Run the hook for one Bash command line. */
function runCommand(command, projectDir = CONFIGS.none, extraEnv = {}) {
  return runRaw(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), projectDir, extraEnv);
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
    const emptyBin = mkdtempSync(join(tmpdir(), 'guard-bash-nopath-'));
    TEMP_DIRS.push(emptyBin);
    const result = spawnSync('/bin/bash', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: emptyBin, CLAUDE_PROJECT_DIR: CONFIGS.none, HOME: emptyBin },
    });
    const got = decisionOf(result);
    assert.ok(got === 'exit 2' || got === DENY, `expected exit 2 (or deny), got: ${got}`);
  });

  it('with jq and every interpreter missing from PATH, a production-touching command is never allowed', () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'guard-bash-nopath-'));
    TEMP_DIRS.push(emptyBin);
    const result = spawnSync('/bin/bash', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `supabase link --project-ref ${PROD}` } }),
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: emptyBin, CLAUDE_PROJECT_DIR: CONFIGS.none, HOME: emptyBin },
    });
    const got = decisionOf(result);
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
  ['supabase db reset --linked', LINK_DECIDES, 'resets the linked project'],
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
  ['supabase link', LINK_DECIDES, 'link with no ref named'],
  ['supabase --debug db push', LINK_DECIDES, 'RF-011: global flag before the verb'],
  ['supabase --workdir . db push', LINK_DECIDES, 'RF-011: global flag with a value'],
  ['supabase --yes db reset --linked', LINK_DECIDES, 'RF-011: global flag before the verb'],
  ['npx supabase db push', LINK_DECIDES, 'through npx'],
  ['npx -y supabase@latest db push', LINK_DECIDES, 'through npx with a version'],
  ['./node_modules/.bin/supabase db push', LINK_DECIDES, 'by path'],
  ['cd supabase && supabase db push', LINK_DECIDES, 'RF-011: cd then run'],
  ['echo y | supabase db reset --linked', LINK_DECIDES, 'piped confirmation'],
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

table('rule 6: a call that names the staging ref is allowed once STAGING_REF is configured', [
  [`supabase link --project-ref ${STAGING}`, NAMES_STAGING, 'link to staging'],
  [`supabase functions deploy report --project-ref ${STAGING}`, NAMES_STAGING, 'deploy to staging'],
  [`supabase secrets list --project-ref ${STAGING}`, NAMES_STAGING, 'read staging'],
  [`supabase --debug link --project-ref ${STAGING}`, NAMES_STAGING, 'global flag first'],
  [`npx supabase link --project-ref ${STAGING}`, NAMES_STAGING, 'through npx'],
  [`supabase link --project-ref "${STAGING}"`, NAMES_STAGING, 'quoted ref'],
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
  [`supabase link --project-ref=${STAGING}`, NAMES_STAGING, 'A5: --project-ref=<staging> names staging too'],
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

table('rule 9: any Python file under e2e/ asks', [
  ['python3 e2e/rls_e2e.py', ASK, 'python3'],
  ['python e2e/rls_e2e.py', ASK, 'python'],
  ['python3 ./e2e/rls_e2e.py', ASK, './ path'],
  ['python3 e2e/saas/tenant_isolation.py', ASK, 'a subdirectory'],
  ['python3 e2e/brand_new_suite.py', ASK, 'a suite nobody has listed'],
  ['python3 -u e2e/rls_e2e.py', ASK, 'interpreter flag first'],
  ['python3 e2e/rls_e2e.py --verbose', ASK, 'with arguments'],
  ['./e2e/rls_e2e.py', ASK, 'executed directly'],
  ['cd e2e && python3 rls_e2e.py', ASK, 'RF-011: cd then run'],
  ['cd e2e; python3 ./rls_e2e.py', ASK, 'cd then run with ./'],
  ['cd e2e/saas && python3 tenant_isolation.py', ASK, 'cd into a subdirectory'],
  ['(cd e2e && python3 rls_e2e.py)', ASK, 'cd in a subshell'],
  ['python3 -m e2e.rls_e2e', ASK, 'as a module'],
  ['python -m e2e.saas.tenant_isolation', ASK, 'as a nested module'],
  ['bash -c "python3 e2e/rls_e2e.py"', ASK, 'bash -c string'],
  ['npm test && python3 e2e/rls_e2e.py', ASK, 'after &&'],
  ['DRILL_E2E_TARGET=staging python3 e2e/rls_e2e.py', ASK, 'RF-010: no environment escape hatch'],
  ['env DRILL_E2E_TARGET=staging python3 e2e/rls_e2e.py', ASK, 'RF-010: through env'],
  ['export DRILL_E2E_TARGET=staging && python3 e2e/rls_e2e.py', ASK, 'RF-010: exported first'],
], STRICT_AND_PERMISSIVE);

table('rule 9: any test:* package script asks, with any runner', [
  ['npm run test:rls', ASK, 'npm run'],
  ['npm run test:e2e', ASK, 'the umbrella script'],
  ['npm run test:something-new', ASK, 'a script nobody has listed'],
  ['npm run test:rls -- --verbose', ASK, 'with arguments'],
  ['npm run-script test:rls', ASK, 'RF-011: npm run-script'],
  ['npm run --silent test:rls', ASK, 'flag between run and the script'],
  ['npm --silent run test:rls', ASK, 'flag before run'],
  ['npm run "test:rls"', ASK, 'quoted script name'],
  ['yarn test:rls', ASK, 'RF-011: yarn'],
  ['yarn run test:rls', ASK, 'yarn run'],
  ['pnpm test:rls', ASK, 'RF-011: pnpm'],
  ['pnpm run test:rls', ASK, 'pnpm run'],
  ['bun run test:rls', ASK, 'RF-011: bun run'],
  ['npm test && npm run test:rls', ASK, 'after a plain npm test'],
  ['cd . && npm run test:sync', ASK, 'after cd'],
  ['bash -c "npm run test:rls"', ASK, 'bash -c string'],
  ['DRILL_E2E_TARGET=staging npm run test:rls', ASK, 'RF-010: no environment escape hatch'],
  ['DRILL_E2E_TARGET=staging npm run test:e2e', ASK, 'RF-010: no environment escape hatch'],
  ['export DRILL_E2E_TARGET=staging; npm run test:rls', ASK, 'RF-010: exported first'],
], STRICT_AND_PERMISSIVE);

describe('rule 9: DRILL_E2E_TARGET=staging in the hook environment changes nothing (RF-010)', () => {
  const rows = [
    'npm run test:rls',
    'python3 e2e/rls_e2e.py',
    'scripts/create-user.sh a@example.com',
    'scripts/delete-test-data.sh',
  ];
  for (const command of rows) {
    for (const configName of STRICT_AND_PERMISSIVE) {
      it(`ask [${configName}]: ${command}`, () => {
        const result = runCommand(command, CONFIGS[configName], { DRILL_E2E_TARGET: 'staging' });
        assert.equal(decisionOf(result), ASK);
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
table('validation: e2e suites reached without naming the file on the interpreter line', [
  ['for f in e2e/*.py; do python3 "$f"; done', ASK, 'a loop over e2e/*.py'],
  ['ls e2e/*.py | xargs -n1 python3', ASK, 'xargs over e2e/*.py'],
  ['find e2e -name "*_e2e.py" -exec python3 {} \\;', ASK, 'find -exec python3'],
  ['python3 < e2e/rls_e2e.py', ASK, 'the file redirected into the interpreter'],
  ['python3 -m unittest discover -s e2e', ASK, 'unittest discovery imports every file under e2e/'],
  ['env -C e2e python3 rls_e2e.py', ASK, 'env -C changes directory first'],
  ['uv run e2e/rls_e2e.py', ASK, 'another runner'],
], STRICT_AND_PERMISSIVE);

// Rule 9: "any test:* package script with any runner".
table('validation: a test:* script reached another way', [
  ['npm run -- test:rls', ASK, 'npm accepts the script name after --'],
  ['npx npm-run-all "test:*"', ASK, 'npm-run-all with a pattern'],
], STRICT_AND_PERMISSIVE);

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
