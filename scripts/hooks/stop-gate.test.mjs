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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

// ===========================================================================
// P0-6 RF-041 (written before implementation): the last-green cache
//
// "The Stop-gate cache key includes the path of every untracked file." The
// hook skips the gate when the tree is the one the gate last passed on. A
// file renamed inside an untracked directory changes neither `git status`
// (which prints only the directory) nor any content hash, so the key must
// carry the paths themselves.
//
// The gate stub appends a line to a log OUTSIDE the repository each time it
// runs, so counting runs does not itself change the tree.
// ===========================================================================

/** A repository on a feature branch whose green gate stub counts its runs. `files` are left untracked. */
function makeCountingRepo(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'stop-gate-cache-test-'));
  const logDir = mkdtempSync(join(tmpdir(), 'stop-gate-cache-log-'));
  TEMP_DIRS.push(repo, logDir);
  const log = join(logDir, 'gate-runs.log');
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  const gate = join(repo, 'scripts', 'gate.sh');
  writeFileSync(gate, `#!/usr/bin/env bash\necho run >> '${log}'\nexit 0\n`);
  chmodSync(gate, 0o755);
  // Added for RF-064 (P0-11): the link directory is git-ignored, as in the real repository.
  writeFileSync(join(repo, '.gitignore'), 'supabase/.temp/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Fixture');
  git(repo, 'checkout', '-q', '-b', 'feature/cache');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  return { repo, runs };
}

/** Run the hook and require that it let the stop through (the stub gate is green). */
function stopOnce(repo) {
  const result = runHook(repo, STOP);
  assert.equal(result.status, 0, describeResult(result));
  assert.ok(!blocks(result), `expected no block: ${describeResult(result)}`);
}

describe('P0-6 RF-041: the last-green cache sees the path of every untracked file', () => {
  it('control: an unchanged tree does not run the gate a second time', () => {
    const { repo, runs } = makeCountingRepo({ 'scratch/a.txt': 'same content\n' });
    stopOnce(repo);
    assert.equal(runs(), 1, 'the gate did not run on the first stop');
    stopOnce(repo);
    assert.equal(runs(), 1, 'the gate ran again although nothing changed');
  });

  const renames = [
    ['a file renamed inside an untracked directory', { 'scratch/a.txt': 'same content\n' }, 'scratch/a.txt', 'scratch/b.txt'],
    ['a file renamed so that it becomes a test file', { 'scratch/notes.txt': 'same content\n' }, 'scratch/notes.txt', 'scratch/notes.test.mjs'],
    ['a file moved into a subdirectory of the same untracked directory', { 'scratch/a.txt': 'same content\n' }, 'scratch/a.txt', 'scratch/deeper/a.txt'],
    ['a file renamed two levels down', { 'scratch/x/y/a.txt': 'same content\n' }, 'scratch/x/y/a.txt', 'scratch/x/y/b.txt'],
    ['one of two files renamed, keeping the order of the two', { 'scratch/a.txt': 'first\n', 'scratch/m.txt': 'second\n' }, 'scratch/m.txt', 'scratch/z.txt'],
    ['an empty file renamed', { 'scratch/a.txt': '' }, 'scratch/a.txt', 'scratch/b.txt'],
    ['a file whose name holds a space renamed', { 'scratch/my notes.txt': 'same content\n' }, 'scratch/my notes.txt', 'scratch/my other notes.txt'],
  ];
  for (const [why, files, from, to] of renames) {
    it(`re-runs the gate: ${why} (content unchanged)`, () => {
      const { repo, runs } = makeCountingRepo(files);
      stopOnce(repo);
      stopOnce(repo);
      assert.equal(runs(), 1, 'precondition: the green result was not cached');
      mkdirSync(dirname(join(repo, to)), { recursive: true });
      renameSync(join(repo, from), join(repo, to));
      stopOnce(repo);
      assert.equal(runs(), 2, `the gate was skipped after ${from} became ${to}`);
    });
  }

  it('after the rename the new state is cached in turn', () => {
    const { repo, runs } = makeCountingRepo({ 'scratch/a.txt': 'same content\n' });
    stopOnce(repo);
    renameSync(join(repo, 'scratch/a.txt'), join(repo, 'scratch/b.txt'));
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate was skipped after the rename');
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate ran again although nothing changed after the rename');
  });
});

// ===========================================================================
// P0-11 RF-064: the last-green cache sees the git-ignored link file
//
// "The 'unchanged since the last green run' key includes the content of
// supabase/.temp/project-ref (or the fact that it is absent). Changing only
// that file re-runs the gate." The file is git-ignored, so neither
// `git status` nor the list of untracked files shows it. The refs are invented.
// ===========================================================================

describe('P0-11 RF-064: changing only supabase/.temp/project-ref re-runs the gate', () => {
  const LINK = 'supabase/.temp/project-ref';
  const REF_A = 'stagingrefstagingref1';
  const REF_B = 'prodrefprodrefprodref1';

  /** A counting repository after two stops, the second of which was skipped. `link` is the link file's content, or null for none. */
  function cachedRepo(link) {
    const made = makeCountingRepo(link === null ? {} : { [LINK]: link });
    stopOnce(made.repo);
    stopOnce(made.repo);
    assert.equal(made.runs(), 1, 'precondition: the green result was not cached');
    return made;
  }

  it('the fixture ignores the link file: git does not list it as untracked', () => {
    const { repo } = makeCountingRepo({ [LINK]: REF_A });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, '', 'the link file shows up in git status, so this would not test RF-064');
  });

  it('control: an unchanged link does not run the gate again', () => {
    const { repo, runs } = cachedRepo(REF_A);
    stopOnce(repo);
    assert.equal(runs(), 1, 'the gate ran again although the link did not change');
  });

  it('control: with no link file at all, nothing changing does not run the gate again', () => {
    const { repo, runs } = cachedRepo(null);
    stopOnce(repo);
    assert.equal(runs(), 1, 'the gate ran again although nothing changed');
  });

  it('control: the link file rewritten with the same content does not run the gate again', () => {
    const { repo, runs } = cachedRepo(REF_A);
    writeFileSync(join(repo, LINK), REF_A);
    stopOnce(repo);
    assert.equal(runs(), 1, 'the key depends on more than the content of the link file');
  });

  it('re-runs the gate when the link file is created', () => {
    const { repo, runs } = cachedRepo(null);
    mkdirSync(dirname(join(repo, LINK)), { recursive: true });
    writeFileSync(join(repo, LINK), REF_A);
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate was skipped after the link file appeared');
  });

  it('re-runs the gate when the content of the link file changes', () => {
    const { repo, runs } = cachedRepo(REF_A);
    writeFileSync(join(repo, LINK), REF_B);
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate was skipped after the link changed to another project');
  });

  it('re-runs the gate when the link file is deleted', () => {
    const { repo, runs } = cachedRepo(REF_A);
    rmSync(join(repo, LINK));
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate was skipped after the link file was removed');
  });

  it('re-runs the gate when an empty link file takes the place of no link file', () => {
    const { repo, runs } = cachedRepo(null);
    mkdirSync(dirname(join(repo, LINK)), { recursive: true });
    writeFileSync(join(repo, LINK), '');
    stopOnce(repo);
    assert.equal(runs(), 2, 'an empty link file and an absent one gave the same key');
  });

  it('re-runs the gate when a second line is added to the link file', () => {
    const { repo, runs } = cachedRepo(`${REF_A}\n`);
    writeFileSync(join(repo, LINK), `${REF_A}\n${REF_B}\n`);
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate was skipped although the link file gained a line');
  });

  it('after the change the new state is cached in turn, and changing back re-runs it', () => {
    const { repo, runs } = cachedRepo(REF_A);
    writeFileSync(join(repo, LINK), REF_B);
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate was skipped after the link changed');
    stopOnce(repo);
    assert.equal(runs(), 2, 'the gate ran again although the link did not change a second time');
    writeFileSync(join(repo, LINK), REF_A);
    stopOnce(repo);
    assert.equal(runs(), 3, 'the gate was skipped after the link changed back');
  });
});
