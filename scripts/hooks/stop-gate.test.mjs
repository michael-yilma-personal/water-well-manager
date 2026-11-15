// WF-4: the Stop hook (scripts/hooks/stop-gate.sh).
//
// Derived from "WF-4 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// (Stop hook: "applies on every branch except main and master, including a
// detached HEAD") and from RF-018 in docs/saas/REVIEW_FINDINGS.md.
//
// The real hook script is run with CLAUDE_PROJECT_DIR pointing at a throwaway
// git repository whose scripts/gate.sh is a stub that exits 0 (green) or 1
// (red). Nothing here runs the real gate.
//
// "Blocks" means the hook tells Claude Code not to stop: a JSON object with
// decision "block" on stdout, or exit status 2.
//
// Run: node --test "scripts/**/*.test.mjs"

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'stop-gate.sh');

const RED = 1;
const GREEN = 0;
const DETACHED = Symbol('detached HEAD');

const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = (() => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Stop Gate Test',
    GIT_AUTHOR_EMAIL: 'stop-gate-test@example.com',
    GIT_COMMITTER_NAME: 'Stop Gate Test',
    GIT_COMMITTER_EMAIL: 'stop-gate-test@example.com',
  };
})();

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A repository on `branch` (or a detached HEAD) whose gate stub exits with `gateStatus`. */
function makeRepo(branch, gateStatus) {
  const repo = mkdtempSync(join(tmpdir(), 'stop-gate-test-'));
  TEMP_DIRS.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  const gate = join(repo, 'scripts', 'gate.sh');
  writeFileSync(gate, `#!/usr/bin/env bash\necho "STUB GATE RAN in mode \${1:-none}"\nexit ${gateStatus}\n`);
  chmodSync(gate, 0o755);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Fixture');
  if (branch === DETACHED) git(repo, 'checkout', '-q', '--detach');
  else if (branch !== 'main') git(repo, 'checkout', '-q', '-b', branch);
  return repo;
}

function runHook(repo, stdin) {
  return spawnSync(HOOK, [], {
    input: stdin,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: repo },
  });
}

function blocks(result) {
  if (result.status === 2) return true;
  const out = result.stdout.trim();
  if (out === '') return false;
  try {
    return JSON.parse(out).decision === 'block';
  } catch {
    return false;
  }
}

const describeResult = (result) => `exit ${result.status}, stdout: ${result.stdout.trim() || '(empty)'}`;

const STOP = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false });
const STOP_AGAIN = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true });

const label = (branch) => (branch === DETACHED ? 'a detached HEAD' : branch);

describe('a red gate blocks the stop on every branch except main and master', () => {
  const rows = [
    ['saas/phase-0-preparation', 'a phase branch'],
    ['chore/agent-workflow', 'the workflow branch'],
    ['feature/photo-upload', 'RF-018: an ordinary feature branch'],
    ['fix/sync-badge', 'RF-018: a fix branch'],
    ['some-feature-branch', 'RF-018: a branch with no prefix'],
    ['maintenance', 'only starts with main'],
    ['feature/main', 'main is only the last segment'],
    ['master-plan', 'only starts with master'],
    [DETACHED, 'RF-018: no branch at all'],
  ];
  for (const [branch, why] of rows) {
    it(`blocks on ${label(branch)} - ${why}`, () => {
      const result = runHook(makeRepo(branch, RED), STOP);
      assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
    });
  }

  it('the block comes with a reason', () => {
    const result = runHook(makeRepo('feature/photo-upload', RED), STOP);
    assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
    if (result.status === 2) {
      assert.notEqual(result.stderr.trim(), '', 'an exit-2 block must explain itself on stderr');
    } else {
      const out = JSON.parse(result.stdout);
      assert.equal(typeof out.reason, 'string');
      assert.notEqual(out.reason.trim(), '');
    }
  });
});

describe('main and master are left alone', () => {
  for (const branch of ['main', 'master']) {
    it(`does not block on ${branch} with a red gate`, () => {
      const result = runHook(makeRepo(branch, RED), STOP);
      assert.equal(result.status, 0, describeResult(result));
      assert.ok(!blocks(result), `expected no block: ${describeResult(result)}`);
    });
  }
});

describe('a green gate never blocks', () => {
  for (const branch of ['saas/phase-0-preparation', 'feature/photo-upload', DETACHED, 'main']) {
    it(`does not block on ${label(branch)}`, () => {
      const result = runHook(makeRepo(branch, GREEN), STOP);
      assert.equal(result.status, 0, describeResult(result));
      assert.ok(!blocks(result), `expected no block: ${describeResult(result)}`);
    });
  }
});

describe('stop_hook_active is respected, so the hook cannot loop', () => {
  for (const branch of ['saas/phase-0-preparation', 'feature/photo-upload', DETACHED]) {
    it(`does not block a second time on ${label(branch)} with a red gate`, () => {
      const result = runHook(makeRepo(branch, RED), STOP_AGAIN);
      assert.equal(result.status, 0, describeResult(result));
      assert.ok(!blocks(result), `expected no block: ${describeResult(result)}`);
    });
  }
});

describe('unexpected input does not let a red gate through', () => {
  it('blocks on a feature branch when stop_hook_active is absent', () => {
    const result = runHook(makeRepo('feature/photo-upload', RED), JSON.stringify({ hook_event_name: 'Stop' }));
    assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
  });

  it('blocks on a feature branch when stdin is empty', () => {
    const result = runHook(makeRepo('feature/photo-upload', RED), '');
    assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
  });

  it('blocks on a phase branch when stdin is empty', () => {
    const result = runHook(makeRepo('saas/phase-0-preparation', RED), '');
    assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
  });
});

// ===========================================================================
// WF-4 validation (after implementation)
// ===========================================================================

describe('validation: a gate that cannot run counts as red', () => {
  it('blocks when scripts/gate.sh is missing', () => {
    const repo = makeRepo('feature/photo-upload', GREEN);
    rmSync(join(repo, 'scripts', 'gate.sh'));
    const result = runHook(repo, STOP);
    assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
  });

  it('blocks when scripts/gate.sh is not executable', () => {
    const repo = makeRepo('feature/photo-upload', GREEN);
    chmodSync(join(repo, 'scripts', 'gate.sh'), 0o644);
    const result = runHook(repo, STOP);
    assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
  });

  it('blocks on a detached HEAD when scripts/gate.sh is missing', () => {
    const repo = makeRepo(DETACHED, GREEN);
    rmSync(join(repo, 'scripts', 'gate.sh'));
    const result = runHook(repo, STOP);
    assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
  });
});

describe('validation: the gate is run in quick mode and its output reaches the reason', () => {
  it('the block reason carries the gate output', () => {
    const result = runHook(makeRepo('feature/photo-upload', RED), STOP);
    assert.ok(blocks(result), describeResult(result));
    const text = result.status === 2 ? result.stderr : JSON.parse(result.stdout).reason;
    assert.match(text, /STUB GATE RAN in mode quick/);
  });
});

describe('validation: only a real stop_hook_active lets a red gate through', () => {
  const rows = [
    ['stop_hook_active is false', JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false })],
    ['stop_hook_active is null', JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: null })],
    ['the phrase appears only inside another value', JSON.stringify({ hook_event_name: 'Stop', note: '"stop_hook_active": true' })],
    ['stdin is not JSON', 'stop_hook_active true'],
    ['stdin is a JSON array', '[true]'],
  ];
  for (const [why, stdin] of rows) {
    it(`blocks when ${why}`, () => {
      const result = runHook(makeRepo('feature/photo-upload', RED), stdin);
      assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
    });
  }
});

describe('validation: a branch that merely resembles main is not exempt', () => {
  for (const branch of ['Main', 'MASTER', 'main2', 'mainline', 'x/master', 'release/main-fix']) {
    it(`blocks on ${branch} with a red gate`, (t) => {
      let repo;
      try {
        repo = makeRepo(branch, RED);
      } catch {
        // A file system that folds case cannot hold both "main" and "Main".
        t.skip(`cannot create a branch named ${branch} next to main here`);
        return;
      }
      const result = runHook(repo, STOP);
      assert.ok(blocks(result), `expected the stop to be blocked: ${describeResult(result)}`);
    });
  }
});
