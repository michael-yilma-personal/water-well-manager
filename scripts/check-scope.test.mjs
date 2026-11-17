// WF-4: the scope check (scripts/check-scope.sh).
//
// Derived from "WF-4 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// (Scope check) and from RF-008, RF-013 and RF-017 in
// docs/saas/REVIEW_FINDINGS.md.
//
// Every test builds a throwaway git repository under os.tmpdir(), points the
// script at it with CHECK_SCOPE_ROOT, takes a snapshot, changes files the way
// an agent would, and then checks a role:
//
//   check-scope.sh snapshot > before.txt
//   check-scope.sh <developer|test-engineer|reviewer> before.txt [--allow <glob>]...
//
// Exit 0 = in scope, 1 = violation, 2 = usage error.
//
// If the script ignores CHECK_SCOPE_ROOT it inspects the real repository, where
// nothing changes between snapshot and check, so every "in scope" expectation
// would pass for the wrong reason. Each test therefore first requires that the
// root is honoured (see requireRoot) and fails if it is not.
//
// Run: node --test "scripts/**/*.test.mjs"

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-scope.sh');

const ROLES = ['developer', 'test-engineer', 'reviewer'];

// ---------------------------------------------------------------------------
// Throwaway repositories
// ---------------------------------------------------------------------------

const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Git that ignores the user's and the machine's configuration. */
const GIT_ENV = (() => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  delete env.CHECK_SCOPE_ROOT;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Scope Test',
    GIT_AUTHOR_EMAIL: 'scope-test@example.com',
    GIT_COMMITTER_NAME: 'Scope Test',
    GIT_COMMITTER_EMAIL: 'scope-test@example.com',
  };
})();

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function write(repo, path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function remove(repo, path) {
  rmSync(join(repo, path));
}

/** The files every test repository starts with, all committed except node_modules/. */
const BASE_FILES = {
  '.gitignore': 'node_modules/\ndist/\n',
  'CLAUDE.md': '# Project rules\n',
  'package.json': '{ "name": "fixture", "scripts": { "test": "node --test" } }\n',
  'package-lock.json': '{ "name": "fixture", "lockfileVersion": 3 }\n',
  '.claude/settings.json': '{ "hooks": {} }\n',
  '.claude/agents/developer.md': '# Developer\n',
  '.github/workflows/ci.yml': 'name: CI\n',
  'scripts/gate.sh': '#!/usr/bin/env bash\nexit 0\n',
  'scripts/check-scope.sh': '#!/usr/bin/env bash\nexit 0\n',
  'scripts/check-secrets.sh': '#!/usr/bin/env bash\nexit 0\n',
  'scripts/check-migrations.mjs': 'export const check = () => [];\n',
  'scripts/check-migrations.test.mjs': '// tests\n',
  'scripts/build-icons.mjs': '// an ordinary script\n',
  'scripts/hooks/guard-bash.sh': '#!/usr/bin/env bash\nexit 0\n',
  'src/app.ts': 'export const app = 1;\n',
  'src/app.test.ts': '// tests\n',
  'src/util.ts': 'export const util = 1;\n',
  'e2e/rls_e2e.py': 'print("e2e")\n',
  'supabase/tests/policies.sql': 'select 1;\n',
  'supabase/migrations/20260101000000_init.sql': 'select 1;\n',
  'docs/readme.md': '# Docs\n',
  'docs/saas/IMPLEMENTATION_STATUS.md': '# Status\n',
};

/** Tests in one block run side by side; each has its own repository. */
const CONCURRENCY = 8;

/** Run a program without blocking the other tests. Resolves with exit status and output. */
function run(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, { ...options, encoding: 'utf8', timeout: 60000 }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ status, stdout, stderr: error && status === -1 ? `${stderr}${error.message}` : stderr });
    });
  });
}

async function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'check-scope-test-'));
  TEMP_DIRS.push(repo);
  for (const [path, content] of Object.entries(BASE_FILES)) write(repo, path, content);
  // Ignored by .gitignore, so git never lists it; the snapshot must record it anyway.
  write(repo, 'node_modules/.package-lock.json', '{ "packages": {} }\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'Initial state']]) {
    const result = await run('git', args, { cwd: repo, env: GIT_ENV });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return repo;
}

function runScript(repo, args) {
  return run(SCRIPT, args, { env: { ...GIT_ENV, CHECK_SCOPE_ROOT: repo } });
}

/**
 * One agent run: optional changes before the snapshot, the snapshot, the
 * agent's changes, then the check for a role. Resolves with exit status and output.
 */
async function scenario({ before, change, role, allow = [] }) {
  const repo = await makeRepo();
  if (before) before(repo);
  const snapshot = await runScript(repo, ['snapshot']);
  assert.equal(snapshot.status, 0, `snapshot failed: ${snapshot.stderr}`);
  // The snapshot file lives outside the repository, as in the documented usage.
  const snapshotDir = mkdtempSync(join(tmpdir(), 'check-scope-snap-'));
  TEMP_DIRS.push(snapshotDir);
  const snapshotFile = join(snapshotDir, 'before.txt');
  writeFileSync(snapshotFile, snapshot.stdout);
  if (change) change(repo);
  const args = [role, snapshotFile];
  for (const glob of allow) args.push('--allow', glob);
  const result = await runScript(repo, args);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

let rootProbe;
/** Fail the calling test unless the script works on CHECK_SCOPE_ROOT. */
async function requireRoot() {
  rootProbe ??= scenario({
    change: (repo) => write(repo, 'probe-for-root.txt', 'x\n'),
    role: 'reviewer',
  }).then((probe) => probe.status === 1 && probe.out.includes('probe-for-root.txt'));
  assert.ok(
    await rootProbe,
    'check-scope.sh does not honour CHECK_SCOPE_ROOT: a file added to the temporary repository was not reported for the reviewer',
  );
}

function expectViolation(result, path) {
  assert.equal(result.status, 1, `expected a violation (exit 1), got exit ${result.status}:\n${result.out}`);
  if (path) assert.ok(result.out.includes(path), `expected the output to name ${path}:\n${result.out}`);
}

function expectInScope(result) {
  assert.equal(result.status, 0, `expected in scope (exit 0), got exit ${result.status}:\n${result.out}`);
}

const edit = (path) => (repo) => write(repo, path, `changed by the agent ${path}\n`);

// ---------------------------------------------------------------------------
// CHECK_SCOPE_ROOT
// ---------------------------------------------------------------------------

describe('CHECK_SCOPE_ROOT points the script at another repository', { concurrency: CONCURRENCY }, () => {
  it('a file added in the temporary repository is reported for the reviewer', async () => {
    await requireRoot();
  });

  it('an untouched temporary repository is in scope for every role', async () => {
    await requireRoot();
    for (const role of ROLES) expectInScope(await scenario({ role }));
  });
});

// ---------------------------------------------------------------------------
// The role rules
// ---------------------------------------------------------------------------

describe('role rules', { concurrency: CONCURRENCY }, () => {
  it('the developer may change application code', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit('src/app.ts') }));
  });

  it('the developer may not change a test file', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'developer', change: edit('src/app.test.ts') }), 'src/app.test.ts');
  });

  it('the developer changing code and a test file is still a violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('src/app.ts')(repo);
        edit('src/app.test.ts')(repo);
      },
    });
    expectViolation(result, 'src/app.test.ts');
  });

  it('the test engineer may change a test file', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'test-engineer', change: edit('src/app.test.ts') }));
  });

  it('the test engineer may not change application code', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'test-engineer', change: edit('src/app.ts') }), 'src/app.ts');
  });

  it('the test engineer may not change a migration', async () => {
    await requireRoot();
    const path = 'supabase/migrations/20260101000000_init.sql';
    expectViolation(await scenario({ role: 'test-engineer', change: edit(path) }), path);
  });

  it('the reviewer may not change application code', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('src/app.ts') }), 'src/app.ts');
  });

  it('the reviewer may not change a test file', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('src/app.test.ts') }), 'src/app.test.ts');
  });

  it('the reviewer may not change ordinary documentation', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('docs/readme.md') }), 'docs/readme.md');
  });
});

// ---------------------------------------------------------------------------
// Test paths, including the widened patterns (RF-017)
// ---------------------------------------------------------------------------

describe('test paths: the developer may not create them, the test engineer may', { concurrency: CONCURRENCY }, () => {
  const testPaths = [
    'src/services/sync.test.ts',
    'src/components/Header.test.tsx',
    'scripts/new-check.test.mjs',
    'src/legacy/parse.test.js',
    'src/legacy/parse.test.cjs',
    'src/services/sync.spec.ts',
    'src/services/sync.spec.mjs',
    'src/components/Header.spec.tsx',
    'src/__tests__/sync.ts',
    'src/services/__tests__/helpers/fixture.json',
    'e2e/saas/tenant_isolation.py',
    'e2e/README.md',
    'supabase/tests/tenancy.sql',
  ];
  for (const path of testPaths) {
    it(`developer creating ${path} is a violation`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'developer', change: edit(path) }), path);
    });
    it(`test engineer creating ${path} is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role: 'test-engineer', change: edit(path) }));
    });
  }

  it('the test of a protected check script is a test file: in scope for the test engineer', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'test-engineer', change: edit('scripts/check-migrations.test.mjs') }));
  });

  it('the test of a protected check script is a test file: a violation for the developer', async () => {
    await requireRoot();
    const path = 'scripts/check-migrations.test.mjs';
    expectViolation(await scenario({ role: 'developer', change: edit(path) }), path);
  });
});

describe('paths that only look like tests are application code', { concurrency: CONCURRENCY }, () => {
  const lookalikes = [
    'src/latest.js',
    'src/inspect.ts',
    'src/testing/helper.ts',
    'src/tests.ts',
    'src/e2e/flow.ts',
    'docs/supabase/tests/notes.md',
  ];
  for (const path of lookalikes) {
    it(`test engineer creating ${path} is a violation`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'test-engineer', change: edit(path) }), path);
    });
    it(`developer creating ${path} is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role: 'developer', change: edit(path) }));
    });
  }
});

// ---------------------------------------------------------------------------
// Protected paths (RF-013)
// ---------------------------------------------------------------------------

const PROTECTED = [
  ['.claude/settings.json', '.claude/**'],
  ['.claude/agents/developer.md', '.claude/**'],
  ['.claude/agents/new-agent.md', '.claude/**'],
  ['.github/workflows/ci.yml', '.github/**'],
  ['.github/workflows/release.yml', '.github/**'],
  ['scripts/hooks/guard-bash.sh', 'scripts/hooks/**'],
  ['scripts/hooks/guard.conf', 'scripts/hooks/**'],
  ['scripts/gate.sh', 'scripts/gate.sh'],
  ['scripts/check-scope.sh', 'scripts/check-*.sh'],
  ['scripts/check-secrets.sh', 'scripts/check-*.sh'],
  ['scripts/check-migrations.mjs', 'scripts/check-*.mjs'],
  ['package.json', 'package.json'],
  ['package-lock.json', 'package-lock.json'],
  ['CLAUDE.md', 'CLAUDE.md'],
  ['.gitignore', '.gitignore'],
  ['node_modules/.package-lock.json', 'node_modules/.package-lock.json'],
];

describe('protected paths: a change is a violation for the developer', { concurrency: CONCURRENCY }, () => {
  for (const [path, rule] of PROTECTED) {
    it(`${path} (${rule})`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'developer', change: edit(path) }), path);
    });
  }

  it('deleting a protected file is a violation', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: (repo) => remove(repo, 'scripts/gate.sh') });
    expectViolation(result, 'scripts/gate.sh');
  });

  it('an ordinary script next to the protected ones is not protected', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit('scripts/build-icons.mjs') }));
  });
});

describe('protected paths: a change is a violation for every role', { concurrency: CONCURRENCY }, () => {
  const sample = ['.claude/settings.json', 'scripts/hooks/guard-bash.sh', 'package.json', 'node_modules/.package-lock.json'];
  for (const path of sample) {
    for (const role of ROLES) {
      it(`${role} changing ${path}`, async () => {
        await requireRoot();
        expectViolation(await scenario({ role, change: edit(path) }), path);
      });
    }
  }
});

describe('node_modules/.package-lock.json is recorded although git ignores it (RF-017)', { concurrency: CONCURRENCY }, () => {
  it('unchanged: in scope', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit('src/app.ts') }));
  });

  it('deleted after the snapshot: a violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => remove(repo, 'node_modules/.package-lock.json'),
    });
    expectViolation(result, 'node_modules/.package-lock.json');
  });

  it('absent at the snapshot and created afterwards: a violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      before: (repo) => remove(repo, 'node_modules/.package-lock.json'),
      change: edit('node_modules/.package-lock.json'),
    });
    expectViolation(result, 'node_modules/.package-lock.json');
  });

  it('absent before and after: in scope', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      before: (repo) => remove(repo, 'node_modules/.package-lock.json'),
      change: edit('src/app.ts'),
    });
    expectInScope(result);
  });
});

// ---------------------------------------------------------------------------
// --allow
// ---------------------------------------------------------------------------

describe('--allow <glob> lets the Lead permit a protected path', { concurrency: CONCURRENCY }, () => {
  for (const [path, rule] of PROTECTED) {
    it(`developer changing ${path} with --allow '${rule}' is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role: 'developer', change: edit(path), allow: [rule] }));
    });
  }

  it('--allow with the exact path of a file under a protected directory', async () => {
    await requireRoot();
    const path = '.github/workflows/ci.yml';
    expectInScope(await scenario({ role: 'developer', change: edit(path), allow: [path] }));
  });

  it('--allow is repeatable: two protected files, two globs', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('package.json')(repo);
        edit('scripts/hooks/guard-bash.sh')(repo);
      },
      allow: ['package.json', 'scripts/hooks/**'],
    });
    expectInScope(result);
  });

  it('two protected files and one glob: the other file is still a violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('package.json')(repo);
        edit('scripts/hooks/guard-bash.sh')(repo);
      },
      allow: ['package.json'],
    });
    expectViolation(result, 'scripts/hooks/guard-bash.sh');
  });

  it('a glob that does not match the changed file permits nothing', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: edit('package.json'), allow: ['docs/**'] });
    expectViolation(result, 'package.json');
  });

  it('allowing package.json does not allow package-lock.json', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: edit('package-lock.json'), allow: ['package.json'] });
    expectViolation(result, 'package-lock.json');
  });

  it('allowing scripts/check-*.sh does not allow scripts/gate.sh', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: edit('scripts/gate.sh'), allow: ['scripts/check-*.sh'] });
    expectViolation(result, 'scripts/gate.sh');
  });

  it('allowing a protected path does not let the developer change a test file', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('package.json')(repo);
        edit('src/app.test.ts')(repo);
      },
      allow: ['package.json'],
    });
    expectViolation(result, 'src/app.test.ts');
  });
});

// ---------------------------------------------------------------------------
// HEAD (RF-017: git history)
// ---------------------------------------------------------------------------

describe('a changed HEAD is a violation for every role', { concurrency: CONCURRENCY }, () => {
  for (const role of ROLES) {
    it(`${role}: an empty commit after the snapshot`, async () => {
      await requireRoot();
      const result = await scenario({
        role,
        change: (repo) => git(repo, 'commit', '-q', '--allow-empty', '-m', 'Agent commit'),
      });
      expectViolation(result);
      assert.match(result.out, /HEAD/i, `expected the output to mention HEAD:\n${result.out}`);
    });
  }

  it('developer: committing an otherwise permitted change', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('src/app.ts')(repo);
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', 'Agent commit');
      },
    });
    expectViolation(result);
    assert.match(result.out, /HEAD/i);
  });

  it('test engineer: committing an otherwise permitted test change', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'test-engineer',
      change: (repo) => {
        edit('src/app.test.ts')(repo);
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', 'Agent commit');
      },
    });
    expectViolation(result);
    assert.match(result.out, /HEAD/i);
  });

  it('reviewer: amending the last commit without changing any file', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'reviewer',
      change: (repo) => git(repo, 'commit', '-q', '--amend', '--allow-empty', '-m', 'Rewritten'),
    });
    expectViolation(result);
    assert.match(result.out, /HEAD/i);
  });

  it('developer: resetting to an earlier commit', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      before: (repo) => git(repo, 'commit', '-q', '--allow-empty', '-m', 'Second commit'),
      change: (repo) => git(repo, 'reset', '-q', '--soft', 'HEAD~1'),
    });
    expectViolation(result);
    assert.match(result.out, /HEAD/i);
  });

  it('a commit made before the snapshot is not attributed', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'reviewer',
      before: (repo) => git(repo, 'commit', '-q', '--allow-empty', '-m', 'Earlier commit'),
    });
    expectInScope(result);
  });
});

// ---------------------------------------------------------------------------
// docs/saas/ is the Lead's record: a violation for every role (P0-6, RF-038)
//
// Changed for RF-038. Before (WF-4, RF-008): a change under docs/saas/ was
// listed as a note and the check exited 0. Owner approvals live in
// docs/saas/IMPLEMENTATION_STATUS.md, so now it is a violation for every role
// unless the Lead passes --allow 'docs/saas/*'.
// ---------------------------------------------------------------------------

describe('P0-6 RF-038: a change under docs/saas/ is a violation for every role', { concurrency: CONCURRENCY }, () => {
  const path = 'docs/saas/IMPLEMENTATION_STATUS.md';
  const ALLOW_DOCS = 'docs/saas/*';

  for (const role of ROLES) {
    it(`${role}: changing ${path} is a violation and the file is named`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role, change: edit(path) }), path);
    });

    it(`${role}: a new file under docs/saas/ is a violation`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role, change: edit('docs/saas/TEST_RESULTS.md') }), 'docs/saas/TEST_RESULTS.md');
    });

    it(`${role}: deleting ${path} is a violation`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role, change: (repo) => remove(repo, path) }), path);
    });

    it(`${role}: changing ${path} with --allow '${ALLOW_DOCS}' is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role, change: edit(path), allow: [ALLOW_DOCS] }));
    });

    it(`${role}: a new file under docs/saas/ with --allow '${ALLOW_DOCS}' is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role, change: edit('docs/saas/TEST_RESULTS.md'), allow: [ALLOW_DOCS] }));
    });
  }

  it('--allow with the exact path permits that file', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit(path), allow: [path] }));
  });

  it('--allow with the exact path of one file does not permit another file under docs/saas/', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit(path)(repo);
        edit('docs/saas/REVIEW_FINDINGS.md')(repo);
      },
      allow: [path],
    });
    expectViolation(result, 'docs/saas/REVIEW_FINDINGS.md');
  });

  it('an --allow glob that does not match permits nothing', async () => {
    await requireRoot();
    // "*" stays inside one path segment, so docs/* is not docs/saas/<file>.
    for (const allow of [['docs/*'], ['docs/readme.md'], ['src/**'], ['saas/*']]) {
      expectViolation(await scenario({ role: 'developer', change: edit(path), allow }), path);
    }
  });

  it('a file dirty under docs/saas/ before the snapshot and untouched afterwards is not attributed', async () => {
    await requireRoot();
    for (const role of ROLES) expectInScope(await scenario({ role, before: edit(path) }));
  });

  it('the developer changing code and docs/saas/ together is a violation that names the docs/saas/ file', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('src/app.ts')(repo);
        edit(path)(repo);
      },
    });
    expectViolation(result, path);
  });

  it('a docs/saas/ change does not hide a real violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'reviewer',
      change: (repo) => {
        edit(path)(repo);
        edit('src/app.ts')(repo);
      },
    });
    expectViolation(result, 'src/app.ts');
  });

  it("--allow 'docs/saas/*' does not lift a role violation next to it", async () => {
    await requireRoot();
    const result = await scenario({
      role: 'reviewer',
      change: (repo) => {
        edit(path)(repo);
        edit('src/app.ts')(repo);
      },
      allow: [ALLOW_DOCS],
    });
    expectViolation(result, 'src/app.ts');
  });

  it("--allow 'docs/saas/*' does not open the rest of docs/ to the reviewer", async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('docs/readme.md'), allow: [ALLOW_DOCS] }), 'docs/readme.md');
  });

  it('a path that only starts like docs/saas is not excused', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('docs/saas-notes.md') }), 'docs/saas-notes.md');
  });

  it('another directory named saas is not excused', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('src/docs/saas/page.ts') }), 'src/docs/saas/page.ts');
  });

  it('another directory named docs/saas is ordinary code for the developer', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit('src/docs/saas/page.ts') }));
  });
});

// ---------------------------------------------------------------------------
// Untracked and deleted files
// ---------------------------------------------------------------------------

describe('untracked and deleted files are seen', { concurrency: CONCURRENCY }, () => {
  it('reviewer creating an untracked file is a violation', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('notes.txt') }), 'notes.txt');
  });

  it('test engineer creating an untracked code file is a violation', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'test-engineer', change: edit('src/helper.ts') }), 'src/helper.ts');
  });

  it('test engineer creating an untracked test file is in scope', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'test-engineer', change: edit('src/helper.test.ts') }));
  });

  it('developer creating an untracked code file is in scope', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit('src/helper.ts') }));
  });

  it('developer deleting a test file is a violation', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: (repo) => remove(repo, 'src/app.test.ts') });
    expectViolation(result, 'src/app.test.ts');
  });

  it('developer deleting a test file with git rm is a violation', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: (repo) => git(repo, 'rm', '-q', 'e2e/rls_e2e.py') });
    expectViolation(result, 'e2e/rls_e2e.py');
  });

  it('test engineer deleting a code file is a violation', async () => {
    await requireRoot();
    const result = await scenario({ role: 'test-engineer', change: (repo) => remove(repo, 'src/util.ts') });
    expectViolation(result, 'src/util.ts');
  });

  it('test engineer deleting a test file is in scope', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'test-engineer', change: (repo) => remove(repo, 'src/app.test.ts') }));
  });

  it('reviewer deleting a file is a violation', async () => {
    await requireRoot();
    const result = await scenario({ role: 'reviewer', change: (repo) => remove(repo, 'docs/readme.md') });
    expectViolation(result, 'docs/readme.md');
  });

  it('staging a change with git add does not hide it', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'reviewer',
      change: (repo) => {
        edit('src/app.ts')(repo);
        git(repo, 'add', '-A');
      },
    });
    expectViolation(result, 'src/app.ts');
  });

  it('a file name with a space is handled: violation for the reviewer', async () => {
    await requireRoot();
    expectViolation(await scenario({ role: 'reviewer', change: edit('src/my notes.ts') }), 'src/my notes.ts');
  });

  it('a test file name with a space is handled: in scope for the test engineer', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'test-engineer', change: edit('src/my notes.test.ts') }));
  });
});

// ---------------------------------------------------------------------------
// What was already uncommitted before the snapshot is not attributed
// ---------------------------------------------------------------------------

describe('uncommitted changes made before the snapshot are not attributed to the agent', { concurrency: CONCURRENCY }, () => {
  const dirtyTree = (repo) => {
    edit('src/app.ts')(repo); // modified, tracked
    edit('src/app.test.ts')(repo); // modified test
    edit('package.json')(repo); // modified protected file
    edit('scratch/new-file.ts')(repo); // untracked
    remove(repo, 'docs/readme.md'); // deleted
  };

  for (const role of ROLES) {
    it(`${role}: a dirty tree and no further change is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role, before: dirtyTree }));
    });
  }

  it('developer: a test file dirty before the snapshot, code changed after, is in scope', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', before: dirtyTree, change: edit('src/util.ts') }));
  });

  it('test engineer: code dirty before the snapshot, a test changed after, is in scope', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'test-engineer', before: dirtyTree, change: edit('src/util.test.ts') }));
  });

  it('a file dirty before the snapshot and changed again afterwards is attributed', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'reviewer',
      before: dirtyTree,
      change: (repo) => write(repo, 'src/app.ts', 'changed a second time\n'),
    });
    expectViolation(result, 'src/app.ts');
  });

  it('a file deleted before the snapshot and recreated afterwards is attributed', async () => {
    await requireRoot();
    const result = await scenario({ role: 'reviewer', before: dirtyTree, change: edit('docs/readme.md') });
    expectViolation(result, 'docs/readme.md');
  });
});

// ---------------------------------------------------------------------------
// Usage errors
// ---------------------------------------------------------------------------

describe('usage errors exit 2', { concurrency: CONCURRENCY }, () => {
  it('no arguments', async () => {
    const repo = await makeRepo();
    assert.equal((await runScript(repo, [])).status, 2);
  });

  it('a role without a snapshot file', async () => {
    const repo = await makeRepo();
    assert.equal((await runScript(repo, ['developer'])).status, 2);
  });

  it('a snapshot file that does not exist', async () => {
    const repo = await makeRepo();
    assert.equal((await runScript(repo, ['developer', join(repo, 'no-such-snapshot.txt')])).status, 2);
  });

  it('an unknown role', async () => {
    const repo = await makeRepo();
    const snapshotFile = join(repo, 'before.txt');
    writeFileSync(snapshotFile, '');
    assert.equal((await runScript(repo, ['lead', snapshotFile])).status, 2);
  });
});

// ===========================================================================
// WF-4 validation (after implementation)
//
// Ruling (f) from the Lead: protected paths never include test files;
// --allow <glob> lifts protected-path violations for any role but never a
// role violation or a HEAD/branch change. Then the "validation: ..." blocks:
// weaknesses found by reading the implementation and trying to break it.
// ===========================================================================

import { appendFileSync, chmodSync } from 'node:fs';

const commitEmpty = (repo) => git(repo, 'commit', '-q', '--allow-empty', '-m', 'Agent commit');
const switchBranch = (repo) => git(repo, 'checkout', '-q', '-b', 'agent-branch');

describe('ruling (f): a test file is never a protected path', { concurrency: CONCURRENCY }, () => {
  const testsUnderProtectedPaths = [
    'scripts/hooks/guard-bash.test.mjs',
    'scripts/hooks/__tests__/guard.mjs',
    'scripts/check-migrations.test.mjs',
    'scripts/check-scope.test.mjs',
    '.claude/hooks/format.test.js',
    '.github/scripts/release.test.cjs',
  ];
  for (const path of testsUnderProtectedPaths) {
    it(`test-engineer changing ${path} needs no --allow`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role: 'test-engineer', change: edit(path) }));
    });

    it(`developer changing ${path} is a role violation`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'developer', change: edit(path) }), path);
    });

    it(`developer changing ${path} stays a violation with --allow for exactly that path`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'developer', change: edit(path), allow: [path] }), path);
    });

    it(`reviewer changing ${path} stays a violation with --allow '**'`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'reviewer', change: edit(path), allow: ['**'] }), path);
    });
  }

  it('the script next to a protected test stays protected for the test engineer', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'test-engineer',
      change: (repo) => {
        edit('scripts/check-migrations.test.mjs')(repo);
        edit('scripts/check-migrations.mjs')(repo);
      },
    });
    expectViolation(result, 'scripts/check-migrations.mjs');
  });
});

describe('ruling (f): --allow lifts a protected-path violation for any role', { concurrency: CONCURRENCY }, () => {
  const cases = [
    ['scripts/gate.sh', 'scripts/gate.sh'],
    ['scripts/hooks/guard-bash.sh', 'scripts/hooks/**'],
    ['.claude/settings.json', '.claude/**'],
    ['package.json', 'package.json'],
  ];
  for (const role of ROLES) {
    for (const [path, glob] of cases) {
      it(`${role} changing ${path} with --allow '${glob}' is in scope`, async () => {
        await requireRoot();
        expectInScope(await scenario({ role, change: edit(path), allow: [glob] }));
      });
    }
  }
});

describe('ruling (f): --allow never lifts a role violation', { concurrency: CONCURRENCY }, () => {
  const rows = [
    ['developer', 'src/app.test.ts', ['**']],
    ['developer', 'src/app.test.ts', ['src/**']],
    ['developer', 'src/app.test.ts', ['src/app.test.ts']],
    ['developer', 'e2e/rls_e2e.py', ['e2e/**']],
    ['developer', 'supabase/tests/policies.sql', ['**']],
    ['test-engineer', 'src/app.ts', ['**']],
    ['test-engineer', 'src/app.ts', ['src/app.ts']],
    ['test-engineer', 'supabase/migrations/20260101000000_init.sql', ['supabase/**']],
    ['test-engineer', 'scripts/build-icons.mjs', ['scripts/*']],
    ['reviewer', 'src/app.ts', ['**']],
    ['reviewer', 'src/app.test.ts', ['**']],
    ['reviewer', 'docs/readme.md', ['docs/**']],
  ];
  for (const [role, path, allow] of rows) {
    it(`${role} changing ${path} with --allow ${allow.join(' ')} is still a violation`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role, change: edit(path), allow }), path);
    });
  }

  it('an allowed protected path next to a role violation: only the role violation is reported', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'test-engineer',
      change: (repo) => {
        edit('scripts/gate.sh')(repo);
        edit('src/app.ts')(repo);
      },
      allow: ['scripts/gate.sh', 'src/**'],
    });
    expectViolation(result, 'src/app.ts');
    assert.ok(!/protected paths changed/.test(result.out), `the allowed protected path was still reported:\n${result.out}`);
  });
});

describe('ruling (f): --allow never lifts a HEAD or branch change', { concurrency: CONCURRENCY }, () => {
  const allows = [['**'], ['*'], ['//HEAD'], ['**', '*', '//HEAD', 'HEAD', '.git/**']];
  for (const role of ROLES) {
    for (const allow of allows) {
      it(`${role}: a commit with --allow ${allow.join(' ')}`, async () => {
        await requireRoot();
        const result = await scenario({ role, change: commitEmpty, allow });
        expectViolation(result);
        assert.match(result.out, /HEAD/);
      });

      it(`${role}: a branch switch with --allow ${allow.join(' ')}`, async () => {
        await requireRoot();
        const result = await scenario({ role, change: switchBranch, allow });
        expectViolation(result);
        assert.match(result.out, /HEAD/);
      });
    }
  }

  it('a commit of an allowed protected file is still a HEAD violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('scripts/gate.sh')(repo);
        git(repo, 'add', 'scripts/gate.sh');
        git(repo, 'commit', '-q', '-m', 'Agent commit');
      },
      allow: ['scripts/gate.sh'],
    });
    expectViolation(result);
    assert.match(result.out, /HEAD/);
  });
});

// ---------------------------------------------------------------------------
// Validation: weaknesses found. Each block is red until the script is changed
// (or the Lead rules the behaviour acceptable).
// ---------------------------------------------------------------------------

describe('validation: a protected file that git ignores is still seen', { concurrency: CONCURRENCY }, () => {
  // .claude/settings.local.json is read by Claude Code (hooks, permissions)
  // and is git-ignored by convention. The snapshot lists only what git lists,
  // plus node_modules/.package-lock.json, so this change is invisible.
  const ignoreLocalSettings = (repo) => appendFileSync(join(repo, '.gitignore'), '.claude/settings.local.json\n');

  for (const role of ROLES) {
    it(`${role} creating a git-ignored .claude/settings.local.json`, async () => {
      await requireRoot();
      const result = await scenario({
        role,
        before: ignoreLocalSettings,
        change: (repo) => write(repo, '.claude/settings.local.json', '{ "hooks": {}, "permissions": { "allow": ["Bash"] } }\n'),
      });
      expectViolation(result, '.claude/settings.local.json');
    });
  }

  it('developer changing an existing git-ignored .claude/settings.local.json', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      before: (repo) => {
        ignoreLocalSettings(repo);
        write(repo, '.claude/settings.local.json', '{ "hooks": { "PreToolUse": [] } }\n');
      },
      change: (repo) => write(repo, '.claude/settings.local.json', '{ "hooks": {} }\n'),
    });
    expectViolation(result, '.claude/settings.local.json');
  });
});

describe('validation: a mode change on a protected file is a change', { concurrency: CONCURRENCY }, () => {
  // The snapshot hashes content only. Removing the executable bit from a hook
  // script stops the hook from running and leaves every hash the same.
  for (const path of ['scripts/hooks/guard-bash.sh', 'scripts/gate.sh', 'scripts/check-secrets.sh']) {
    it(`developer running chmod on ${path}`, async () => {
      await requireRoot();
      const result = await scenario({
        role: 'developer',
        before: (repo) => chmodSync(join(repo, path), 0o755),
        change: (repo) => chmodSync(join(repo, path), 0o644),
      });
      expectViolation(result, path);
    });
  }
});

describe('validation: a file under a protected path that is only named like a test', { concurrency: CONCURRENCY }, () => {
  // "*.spec.*" makes any extension a test file. A workflow or an agent
  // definition named that way is live configuration, yet the test engineer
  // may add it without --allow.
  const rows = [
    ['.github/workflows/extra.spec.yml', 'a GitHub Actions workflow: it runs in CI'],
    ['.claude/agents/helper.spec.md', 'a Claude Code agent definition'],
  ];
  for (const [path, why] of rows) {
    it(`test-engineer adding ${path} - ${why}`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'test-engineer', change: edit(path) }), path);
    });
  }
});

describe('validation: a file whose name git prints quoted is still seen', { concurrency: CONCURRENCY }, () => {
  // git ls-files without -z prints a name holding a double quote or a
  // backslash in C-quoted form; the snapshot then looks for a file of that
  // quoted name, finds none, and drops it.
  const rows = [
    ['developer', '.claude/extra"settings.json'],
    ['developer', 'src/quoted"name.test.ts'],
    ['reviewer', 'src/quoted"name.ts'],
  ];
  for (const [role, path] of rows) {
    it(`${role} adding ${path}`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role, change: edit(path) }));
    });
  }
});

// ===========================================================================
// P0-6 (written before implementation): RF-043 and RF-046
// ===========================================================================

describe('P0-6 RF-043: supabase/.temp/** is a protected path', { concurrency: CONCURRENCY }, () => {
  // supabase/.temp/project-ref is the link file the guard hook reads to decide
  // whether a supabase CLI call is "provably staging".
  const LINK = 'supabase/.temp/project-ref';
  const paths = [LINK, 'supabase/.temp/pooler-url', 'supabase/.temp/cli-latest', 'supabase/.temp/nested/dir/file'];

  for (const role of ROLES) {
    for (const path of paths) {
      it(`${role} creating ${path} is a violation`, async () => {
        await requireRoot();
        expectViolation(await scenario({ role, change: edit(path) }), path);
      });
    }

    it(`${role} rewriting an existing ${LINK} is a violation`, async () => {
      await requireRoot();
      const result = await scenario({
        role,
        before: (repo) => write(repo, LINK, 'stagingrefstagingref1'),
        change: (repo) => write(repo, LINK, 'otherrefotherrefother1'),
      });
      expectViolation(result, LINK);
    });

    it(`${role} deleting ${LINK} is a violation`, async () => {
      await requireRoot();
      const result = await scenario({
        role,
        before: (repo) => write(repo, LINK, 'stagingrefstagingref1'),
        change: (repo) => remove(repo, LINK),
      });
      expectViolation(result, LINK);
    });

    it(`${role} creating ${LINK} with --allow 'supabase/.temp/**' is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role, change: edit(LINK), allow: ['supabase/.temp/**'] }));
    });

    it(`${role}: an existing ${LINK} left alone is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role, before: (repo) => write(repo, LINK, 'stagingrefstagingref1') }));
    });
  }

  it('--allow with the exact path of the link file permits it', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit(LINK), allow: [LINK] }));
  });

  it('--allow for another protected path does not permit the link file', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: edit(LINK), allow: ['scripts/hooks/**', 'supabase/migrations/**'] });
    expectViolation(result, LINK);
  });

  it('the rest of supabase/ is not protected: the developer may add a migration', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit('supabase/migrations/20260201000000_next.sql') }));
  });

  it('a directory that only looks like it is not protected', async () => {
    await requireRoot();
    expectInScope(await scenario({ role: 'developer', change: edit('supabase/.temporary/notes.ts') }));
    expectInScope(await scenario({ role: 'developer', change: edit('src/supabase/.temp/cache.ts') }));
  });

  // The supabase CLI's own .gitignore usually hides .temp/. A protected file
  // that git ignores must still be seen (as .claude/settings.local.json is).
  const ignoreTemp = (repo) => appendFileSync(join(repo, '.gitignore'), 'supabase/.temp/\n');
  for (const role of ROLES) {
    it(`${role} creating a git-ignored ${LINK} is a violation`, async () => {
      await requireRoot();
      const result = await scenario({ role, before: ignoreTemp, change: (repo) => write(repo, LINK, 'otherrefotherrefother1') });
      expectViolation(result, LINK);
    });
  }

  it('developer rewriting a git-ignored link file is a violation; with --allow it is in scope', async () => {
    await requireRoot();
    const before = (repo) => {
      ignoreTemp(repo);
      write(repo, LINK, 'stagingrefstagingref1');
    };
    const change = (repo) => write(repo, LINK, 'otherrefotherrefother1');
    expectViolation(await scenario({ role: 'developer', before, change }), LINK);
    expectInScope(await scenario({ role: 'developer', before, change, allow: ['supabase/.temp/**'] }));
  });
});

describe('P0-6 RF-046: __tests__/ under .claude/ and .github/ is not a test path', { concurrency: CONCURRENCY }, () => {
  const paths = [
    '.claude/__tests__/helper.mjs',
    '.claude/hooks/__tests__/run.sh',
    '.claude/agents/__tests__/extra-agent.md',
    '.github/__tests__/setup.js',
    '.github/workflows/__tests__/release.yml',
  ];
  for (const path of paths) {
    it(`test-engineer adding ${path} is a violation (protected, not a test)`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'test-engineer', change: edit(path) }), path);
    });

    it(`developer adding ${path} is a violation`, async () => {
      await requireRoot();
      expectViolation(await scenario({ role: 'developer', change: edit(path) }), path);
    });

    // A test file stays closed to the developer whatever --allow says
    // (ruling f); a protected path is lifted by --allow for any role. So this
    // row tells the two apart.
    it(`developer adding ${path} with --allow for exactly that path is in scope: it is a protected path`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role: 'developer', change: edit(path), allow: [path] }));
    });

    it(`test-engineer adding ${path} with --allow for exactly that path is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role: 'test-engineer', change: edit(path), allow: [path] }));
    });
  }

  it('unchanged: *.test.<js or ts extension> files under .claude/ and .github/ stay test files', async () => {
    await requireRoot();
    for (const path of ['.claude/hooks/format.test.js', '.github/scripts/release.test.cjs', '.claude/hooks/format.test.mjs', '.github/scripts/release.test.ts']) {
      expectInScope(await scenario({ role: 'test-engineer', change: edit(path) }));
      expectViolation(await scenario({ role: 'developer', change: edit(path), allow: [path] }), path);
    }
  });

  it('unchanged: __tests__/ elsewhere stays a test path, also under scripts/hooks/', async () => {
    await requireRoot();
    for (const path of ['src/__tests__/sync.ts', 'scripts/hooks/__tests__/guard.mjs']) {
      expectInScope(await scenario({ role: 'test-engineer', change: edit(path) }));
      expectViolation(await scenario({ role: 'developer', change: edit(path), allow: [path] }), path);
    }
  });
});

describe('P0-6 RF-046: .gitattributes and .git/info/exclude changes are violations', { concurrency: CONCURRENCY }, () => {
  const EXCLUDE = '.git/info/exclude';
  const hide = (repo) => {
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    appendFileSync(join(repo, EXCLUDE), 'src/hidden.ts\n');
  };

  for (const role of ROLES) {
    it(`${role} creating .gitattributes is a violation`, async () => {
      await requireRoot();
      const result = await scenario({ role, change: (repo) => write(repo, '.gitattributes', '*.test.ts -diff\n') });
      expectViolation(result, '.gitattributes');
    });

    it(`${role} changing a committed .gitattributes is a violation`, async () => {
      await requireRoot();
      const result = await scenario({
        role,
        before: (repo) => {
          write(repo, '.gitattributes', '* text=auto\n');
          git(repo, 'add', '.gitattributes');
          git(repo, 'commit', '-q', '-m', 'Attributes');
        },
        change: (repo) => write(repo, '.gitattributes', '* text=auto\n*.sql filter=secret\n'),
      });
      expectViolation(result, '.gitattributes');
    });

    it(`${role} adding a line to ${EXCLUDE} is a violation`, async () => {
      await requireRoot();
      const result = await scenario({ role, change: hide });
      expectViolation(result);
      assert.match(result.out, /info\/exclude/, `expected the output to name ${EXCLUDE}:\n${result.out}`);
    });
  }

  it('developer deleting a committed .gitattributes is a violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      before: (repo) => {
        write(repo, '.gitattributes', '* text=auto\n');
        git(repo, 'add', '.gitattributes');
        git(repo, 'commit', '-q', '-m', 'Attributes');
      },
      change: (repo) => remove(repo, '.gitattributes'),
    });
    expectViolation(result, '.gitattributes');
  });

  it('developer emptying .git/info/exclude is a violation', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', before: hide, change: (repo) => writeFileSync(join(repo, EXCLUDE), '') });
    expectViolation(result);
    assert.match(result.out, /info\/exclude/);
  });

  it('developer deleting .git/info/exclude is a violation', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', before: hide, change: (repo) => rmSync(join(repo, EXCLUDE)) });
    expectViolation(result);
    assert.match(result.out, /info\/exclude/);
  });

  it('hiding a new file through .git/info/exclude does not go unseen', async () => {
    await requireRoot();
    // The excluded file itself is ignored from now on; the exclude change is what gives it away.
    const result = await scenario({
      role: 'reviewer',
      change: (repo) => {
        hide(repo);
        write(repo, 'src/hidden.ts', 'export const hidden = 1;\n');
      },
    });
    expectViolation(result);
    assert.match(result.out, /info\/exclude/);
  });

  it('control: an exclude file and a .gitattributes changed before the snapshot and left alone are in scope', async () => {
    await requireRoot();
    const before = (repo) => {
      hide(repo);
      write(repo, '.gitattributes', '* text=auto\n');
    };
    for (const role of ROLES) expectInScope(await scenario({ role, before }));
  });

  it('a directory attributes file is seen too', async () => {
    await requireRoot();
    const result = await scenario({ role: 'developer', change: (repo) => write(repo, 'src/.gitattributes', '*.ts -diff\n') });
    expectViolation(result, 'src/.gitattributes');
  });
});

describe('P0-6 RF-046: the Stop-gate key file is in the snapshot', { concurrency: CONCURRENCY }, () => {
  // scripts/hooks/stop-gate.sh keeps the identifier of the last green tree in
  // <git dir>/drill-stop-gate-green. Writing the current tree's identifier
  // there makes the Stop hook skip the gate.
  const KEY_FILE = '.git/drill-stop-gate-green';
  const setKey = (value) => (repo) => writeFileSync(join(repo, KEY_FILE), value);

  for (const role of ROLES) {
    it(`${role}: the key file appearing is a violation`, async () => {
      await requireRoot();
      const result = await scenario({ role, change: setKey('0123456789abcdef0123456789abcdef01234567\n') });
      expectViolation(result);
      assert.match(result.out, /drill-stop-gate-green/, `expected the output to name the key file:\n${result.out}`);
    });

    it(`${role}: the key file changing is a violation`, async () => {
      await requireRoot();
      const result = await scenario({
        role,
        before: setKey('0123456789abcdef0123456789abcdef01234567\n'),
        change: setKey('fedcba9876543210fedcba9876543210fedcba98\n'),
      });
      expectViolation(result);
      assert.match(result.out, /drill-stop-gate-green/);
    });

    it(`${role}: control - a key file that is present and unchanged is in scope`, async () => {
      await requireRoot();
      expectInScope(await scenario({ role, before: setKey('0123456789abcdef0123456789abcdef01234567\n') }));
    });
  }

  it('the key file being deleted is a violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      before: setKey('0123456789abcdef0123456789abcdef01234567\n'),
      change: (repo) => rmSync(join(repo, KEY_FILE)),
    });
    expectViolation(result);
    assert.match(result.out, /drill-stop-gate-green/);
  });

  it('a key-file change next to a permitted change is still a violation', async () => {
    await requireRoot();
    const result = await scenario({
      role: 'developer',
      change: (repo) => {
        edit('src/app.ts')(repo);
        setKey('0123456789abcdef0123456789abcdef01234567\n')(repo);
      },
    });
    expectViolation(result);
    assert.match(result.out, /drill-stop-gate-green/);
  });
});
