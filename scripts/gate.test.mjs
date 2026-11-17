// WF-4 validation: the quality gate (scripts/gate.sh).
//
// Derived from "WF-4 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// (Gate: "script tests run scripts/**/*.test.mjs; a run that finds zero script
// tests fails") and from the gate's own contract: non-zero when any gate
// fails, every gate runs even after a failure, `full` adds the build.
//
// The real gate.sh is copied into a throwaway project directory, because the
// script works on the directory it lives in. Around it:
//   - a stub `npm` first on PATH, which logs its arguments and exits with a
//     status chosen per subcommand (so no type check, unit test or build of
//     the real project runs, and nothing recurses into this test suite);
//   - stub scripts/check-migrations.mjs and scripts/check-secrets.sh;
//   - whatever scripts/**/*.test.mjs files the test puts there, run by the
//     real `node --test`.
//
// P0-6 (docs/saas/IMPLEMENTATION_STATUS.md, "P0-6 acceptance criteria"):
//   - RF-044: there is no fallback to `npm test` when tsx is missing. The
//     unit-test step is stubbed with GATE_UNIT_TEST_CMD instead: a command
//     string the gate runs in place of its node/tsx command (for tests only).
//     runGate sets it to `true` unless a test says otherwise.
//   - RF-042: the fixture is a git repository, because "tracked, or untracked
//     and not ignored" is a question only git can answer.
//   - last bullet: the fixture holds an e2e/target_selftest.py that exits with
//     a chosen status (0 by default) and leaves a marker file when it ran.
//
// Run: node --test "scripts/**/*.test.mjs"

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'gate.sh');

const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const PASSING_TEST = "import { it } from 'node:test';\nit('passes', () => {});\n";
const FAILING_TEST = "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('fails', () => { assert.equal(1, 2); });\n";
const SKIPPED_TEST = "import { it } from 'node:test';\nit.skip('is skipped', () => { throw new Error('never runs'); });\n";
const NO_TESTS = 'export const nothing = 1;\n';

const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_NPM_LOG"
case " $* " in
  *" lint "*)  exit "\${STUB_LINT:-0}" ;;
  *" test "*)  exit "\${STUB_UNIT:-0}" ;;
  *" build "*) exit "\${STUB_BUILD:-0}" ;;
esac
exit 0
`;

/** Environment without the caller's git settings, so the fixture repository stands alone. */
const CLEAN_ENV = (() => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  // Set by the test runner this file runs under; with it, a nested
  // `node --test` reports to its parent instead of printing a summary.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.GATE_UNIT_TEST_CMD;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
})();

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, env: CLEAN_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

const SELFTEST_MARKER = 'selftest.ran';
const selftestScript = (status) => `import pathlib, sys
pathlib.Path(__file__).resolve().parent.parent.joinpath('${SELFTEST_MARKER}').write_text('ran')
sys.exit(${status})
`;

/**
 * A project directory (a git repository) holding a copy of the real gate.sh.
 * `tests` maps paths to file contents; `migrations` and `secrets` are the exit
 * statuses of the stub checks; `selftest` is the exit status of
 * e2e/target_selftest.py, or null for no such file; `gitignore` is the content
 * of .gitignore, or null for none; `tracked` lists paths to `git add`
 * (everything else stays untracked).
 *
 * Changed for RF-059 (P0-10): the fixture now holds scripts/hooks/guard.conf
 * with an invented production ref, because the gate "working copy is not
 * linked to production" fails when that file cannot be read. `guardConf` is
 * the file's content, or null for no file; `link` is the content of
 * supabase/.temp/project-ref, or null for no file (the default).
 */
const FIXTURE_PROD = 'prodrefprodrefprodref1';
const FIXTURE_STAGING = 'stagingrefstagingref1';
const DEFAULT_GUARD_CONF = `# invented refs for the gate's tests\nPROD_REF=${FIXTURE_PROD}\nSTAGING_REF=${FIXTURE_STAGING}\n`;

function makeProject({
  tests = { 'scripts/sample.test.mjs': PASSING_TEST },
  migrations = 0,
  secrets = 0,
  selftest = 0,
  gitignore = null,
  tracked = [],
  guardConf = DEFAULT_GUARD_CONF,
  link = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'));
  TEMP_DIRS.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  copyFileSync(GATE, join(dir, 'scripts', 'gate.sh'));
  chmodSync(join(dir, 'scripts', 'gate.sh'), 0o755);
  writeFileSync(join(dir, 'bin', 'npm'), NPM_STUB);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  writeFileSync(join(dir, 'package.json'), '{ "name": "gate-fixture", "type": "module" }\n');
  writeFileSync(join(dir, 'scripts', 'check-migrations.mjs'), `process.exit(${migrations});\n`);
  writeFileSync(join(dir, 'scripts', 'check-secrets.sh'), `#!/usr/bin/env bash\nexit ${secrets}\n`);
  chmodSync(join(dir, 'scripts', 'check-secrets.sh'), 0o755);
  if (selftest !== null) {
    mkdirSync(join(dir, 'e2e'), { recursive: true });
    writeFileSync(join(dir, 'e2e', 'target_selftest.py'), selftestScript(selftest));
  }
  if (gitignore !== null) writeFileSync(join(dir, '.gitignore'), gitignore);
  if (guardConf !== null) {
    mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'hooks', 'guard.conf'), guardConf);
  }
  if (link !== null) {
    mkdirSync(join(dir, 'supabase', '.temp'), { recursive: true });
    writeFileSync(join(dir, 'supabase', '.temp', 'project-ref'), link);
  }
  for (const [path, content] of Object.entries(tests)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  for (const path of tracked) git(dir, 'add', '--', path);
  return dir;
}

/**
 * Run the copied gate. Resolves with exit status, output and the stub npm's log lines.
 * The unit-test step is `true` unless `stub.GATE_UNIT_TEST_CMD` says otherwise;
 * `GATE_UNIT_TEST_CMD: null` leaves the variable unset, so the gate runs its
 * real unit-test command.
 */
function runGate(dir, args = [], stub = {}) {
  const env = { ...CLEAN_ENV, GATE_UNIT_TEST_CMD: 'true', ...stub };
  for (const [name, value] of Object.entries(env)) {
    if (value === null || value === undefined) delete env[name];
  }
  const log = join(dir, 'npm.log');
  return new Promise((resolve) => {
    execFile(
      join(dir, 'scripts', 'gate.sh'),
      args,
      { env: { ...env, PATH: `${join(dir, 'bin')}:${env.PATH}`, STUB_NPM_LOG: log }, encoding: 'utf8', timeout: 120000 },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        const npm = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
        resolve({ status, out: `${stdout}${stderr}`, stdout, npm });
      },
    );
  });
}

const isGreen = (result) => result.status === 0 && /GATE GREEN/.test(result.out);
const show = (result) => `exit ${result.status}\n${result.out}`;

describe('validation: the gate fixture works (a green gate is green)', { concurrency: 4 }, () => {
  it('everything passing: exit 0 and GATE GREEN', async () => {
    const result = await runGate(makeProject());
    assert.ok(isGreen(result), show(result));
  });

  // Changed for RF-044 (P0-6). Before: the unit-test step reached the stub
  // through the `npm test` fallback, so a "test" call had to be in the log.
  // Now there is no fallback: the type check still goes through the stub npm,
  // and the unit-test step runs GATE_UNIT_TEST_CMD and never `npm test`.
  it('the stub npm is the one the gate ran, and the unit-test step is GATE_UNIT_TEST_CMD', async () => {
    const dir = makeProject();
    const marker = join(dir, 'unit-step.ran');
    const result = await runGate(dir, [], { GATE_UNIT_TEST_CMD: `touch ${marker}` });
    assert.ok(result.npm.some((line) => /\blint\b/.test(line)), `no lint call was logged: ${result.npm.join(' | ')}`);
    assert.ok(existsSync(marker), `GATE_UNIT_TEST_CMD was not run:\n${show(result)}`);
    assert.ok(!result.npm.some((line) => /\btest\b/.test(line)), `npm test was called: ${result.npm.join(' | ')}`);
    assert.ok(isGreen(result), show(result));
  });

  it('no mode given means quick: no build', async () => {
    const result = await runGate(makeProject());
    assert.ok(isGreen(result), show(result));
    assert.ok(!result.npm.some((line) => /\bbuild\b/.test(line)), 'the default mode ran the build');
  });
});

describe('validation: a run that finds zero script tests fails', { concurrency: 4 }, () => {
  it('no *.test.mjs file anywhere under scripts/', async () => {
    const result = await runGate(makeProject({ tests: {} }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /GATE RED/);
    assert.match(result.out, /FAIL +script tests/);
  });

  it('test files exist, but none under scripts/', async () => {
    const result = await runGate(makeProject({ tests: { 'src/app.test.mjs': PASSING_TEST, 'tools/x.test.mjs': PASSING_TEST } }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +script tests/);
  });

  it('only a *.test.js and a *.test.ts under scripts/: not the pattern, so zero found', async () => {
    const result = await runGate(makeProject({ tests: { 'scripts/a.test.js': PASSING_TEST, 'scripts/b.test.ts': PASSING_TEST } }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +script tests/);
  });

  it('zero script tests is red in full mode too', async () => {
    const result = await runGate(makeProject({ tests: {} }), ['full']);
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +script tests/);
  });
});

describe('validation: script tests are found at any depth under scripts/', { concurrency: 4 }, () => {
  it('a passing test in scripts/hooks/ alone is enough', async () => {
    const result = await runGate(makeProject({ tests: { 'scripts/hooks/deep.test.mjs': PASSING_TEST } }));
    assert.ok(isGreen(result), show(result));
  });

  it('a failing test in scripts/hooks/ turns the gate red', async () => {
    const result = await runGate(makeProject({
      tests: { 'scripts/top.test.mjs': PASSING_TEST, 'scripts/hooks/deep.test.mjs': FAILING_TEST },
    }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +script tests/);
  });

  it('a failing test three directories down turns the gate red', async () => {
    const result = await runGate(makeProject({
      tests: { 'scripts/top.test.mjs': PASSING_TEST, 'scripts/a/b/c/deep.test.mjs': FAILING_TEST },
    }));
    assert.notEqual(result.status, 0, show(result));
  });

  it('a failing test at the top of scripts/ turns the gate red', async () => {
    const result = await runGate(makeProject({ tests: { 'scripts/top.test.mjs': FAILING_TEST } }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /GATE RED/);
  });

  it('a test file that does not parse turns the gate red', async () => {
    const result = await runGate(makeProject({
      tests: { 'scripts/top.test.mjs': PASSING_TEST, 'scripts/broken.test.mjs': 'this is not ( javascript\n' },
    }));
    assert.notEqual(result.status, 0, show(result));
  });
});

describe('validation: each gate turns the whole gate red, and the others still run', { concurrency: 4 }, () => {
  const rows = [
    ['the type check fails', {}, { STUB_LINT: '1' }, /FAIL +typecheck/],
    // Changed for RF-044 (P0-6): was { STUB_UNIT: '1' }, a failing `npm test` fallback.
    ['the unit tests fail', {}, { GATE_UNIT_TEST_CMD: 'false' }, /FAIL +unit tests/],
    ['the migration check fails', { migrations: 1 }, {}, /FAIL +migrations/],
    ['the secret scan finds something', { secrets: 1 }, {}, /FAIL +no secrets/],
    ['the secret scan itself fails (exit 2)', { secrets: 2 }, {}, /FAIL +no secrets/],
  ];
  for (const [why, project, stub, failLine] of rows) {
    it(`${why}: non-zero, GATE RED, and that gate is named`, async () => {
      const result = await runGate(makeProject(project), [], stub);
      assert.notEqual(result.status, 0, show(result));
      assert.match(result.out, /GATE RED/);
      assert.match(result.out, failLine);
      assert.ok(!/GATE GREEN/.test(result.out), show(result));
    });
  }

  it('after the first gate fails, the later gates still run and pass', async () => {
    const result = await runGate(makeProject(), [], { STUB_LINT: '1' });
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /PASS +unit tests/);
    assert.match(result.out, /PASS +script tests/);
    assert.match(result.out, /PASS +migrations/);
    assert.match(result.out, /PASS +no secrets/);
  });

  it('a secret scan that is missing is red, not skipped', async () => {
    const dir = makeProject();
    rmSync(join(dir, 'scripts', 'check-secrets.sh'));
    const result = await runGate(dir);
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +no secrets/);
  });

  it('a migration check that is missing is red, not skipped', async () => {
    const dir = makeProject();
    rmSync(join(dir, 'scripts', 'check-migrations.mjs'));
    const result = await runGate(dir);
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +migrations/);
  });
});

describe('validation: full mode adds the build', { concurrency: 4 }, () => {
  it('full runs the build', async () => {
    const result = await runGate(makeProject(), ['full']);
    assert.ok(isGreen(result), show(result));
    assert.ok(result.npm.some((line) => /\bbuild\b/.test(line)), `no build call was logged: ${result.npm.join(' | ')}`);
  });

  it('quick does not run the build', async () => {
    const result = await runGate(makeProject(), ['quick']);
    assert.ok(isGreen(result), show(result));
    assert.ok(!result.npm.some((line) => /\bbuild\b/.test(line)), 'quick ran the build');
  });

  it('a failing build turns full red', async () => {
    const result = await runGate(makeProject(), ['full'], { STUB_BUILD: '1' });
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +production build/);
  });

  it('a failing build does not matter to quick', async () => {
    const result = await runGate(makeProject(), ['quick'], { STUB_BUILD: '1' });
    assert.ok(isGreen(result), show(result));
  });
});

// ---------------------------------------------------------------------------
// Weaknesses found. Each block is red until the script is changed (or the
// Lead rules the behaviour acceptable).
// ---------------------------------------------------------------------------

describe('validation: a mode the gate does not know is an error, not a green quick gate', { concurrency: 4 }, () => {
  // `scripts/gate.sh ful` runs the quick gates and prints "GATE GREEN (ful)":
  // the caller asked for the build and is told green without it.
  for (const mode of ['ful', 'FULL', '--full', 'all']) {
    it(`gate.sh ${mode}`, async () => {
      const result = await runGate(makeProject(), [mode]);
      const ranBuild = result.npm.some((line) => /\bbuild\b/.test(line));
      assert.ok(
        result.status !== 0 || ranBuild,
        `mode "${mode}" was reported green without the build and without an error:\n${show(result)}`,
      );
    });
  }
});

describe('validation: script test files that run no test are not a pass', { concurrency: 4 }, () => {
  // The zero-test rule exists so that "nothing was checked" cannot look green.
  // A run in which every test is skipped checks nothing either.
  it('the only *.test.mjs file defines no test at all (node counts the file itself as one passing test)', async () => {
    const result = await runGate(makeProject({ tests: { 'scripts/empty.test.mjs': NO_TESTS } }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +script tests/);
  });

  it('the only script test is skipped', async () => {
    const result = await runGate(makeProject({ tests: { 'scripts/only.test.mjs': SKIPPED_TEST } }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +script tests/);
  });
});

// ===========================================================================
// P0-6 (written before implementation)
// ===========================================================================

describe('P0-6 RF-044: a missing tsx makes the gate red; there is no fallback to npm test', { concurrency: 4 }, () => {
  // The fixture has no node_modules/tsx. The stub `npm test` would exit 0.
  const withUnitTest = { 'scripts/sample.test.mjs': PASSING_TEST, 'src/a.test.ts': PASSING_TEST };

  it('no tsx and no GATE_UNIT_TEST_CMD: red, the unit tests are the failed gate, npm test is not called', async () => {
    const result = await runGate(makeProject({ tests: withUnitTest }), [], { GATE_UNIT_TEST_CMD: null });
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /GATE RED/);
    assert.match(result.out, /FAIL +unit tests/);
    assert.ok(!result.npm.some((line) => /\btest\b/.test(line)), `npm test was called: ${result.npm.join(' | ')}`);
  });

  it('no tsx and an empty GATE_UNIT_TEST_CMD: the same as unset', async () => {
    const result = await runGate(makeProject({ tests: withUnitTest }), [], { GATE_UNIT_TEST_CMD: '' });
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +unit tests/);
    assert.ok(!result.npm.some((line) => /\btest\b/.test(line)), `npm test was called: ${result.npm.join(' | ')}`);
  });

  it('no tsx is red in full mode too', async () => {
    const result = await runGate(makeProject({ tests: withUnitTest }), ['full'], { GATE_UNIT_TEST_CMD: null });
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /FAIL +unit tests/);
  });

  it('a failing `npm test` no longer matters: the unit-test step is not npm', async () => {
    const result = await runGate(makeProject(), [], { STUB_UNIT: '1' });
    assert.ok(isGreen(result), show(result));
  });

  it('GATE_UNIT_TEST_CMD that fails is red; one that passes is green', async () => {
    const red = await runGate(makeProject(), [], { GATE_UNIT_TEST_CMD: 'false' });
    assert.notEqual(red.status, 0, show(red));
    assert.match(red.out, /FAIL +unit tests/);
    const green = await runGate(makeProject(), [], { GATE_UNIT_TEST_CMD: 'true' });
    assert.ok(isGreen(green), show(green));
    assert.match(green.out, /PASS +unit tests/);
  });
});

describe('P0-6 RF-042: a test-named file that no gate command runs makes the gate red', { concurrency: 4 }, () => {
  const COVERED = { 'scripts/sample.test.mjs': PASSING_TEST, 'src/services/sync.test.ts': PASSING_TEST };
  const strays = [
    ['src/a/ui.test.tsx', 'a .test.tsx under src/'],
    ['src/x.test.mjs', 'a .test.mjs under src/'],
    ['lib/foo.spec.ts', 'a .spec.ts outside src/ and scripts/'],
    ['src/app.spec.ts', 'a .spec.ts under src/'],
    ['src/__tests__/a.ts', 'a file under __tests__/'],
    ['src/services/__tests__/helpers/fixture.json', 'any file below __tests__/'],
    ['scripts/b.test.ts', 'a .test.ts under scripts/'],
    ['scripts/c.test.js', 'a .test.js under scripts/'],
    ['tools/x.test.mjs', 'a .test.mjs outside scripts/'],
    ['top.test.ts', 'a .test.ts at the top level'],
    ['e2e/helper.test.ts', 'under e2e/ but not Python'],
  ];
  for (const [path, why] of strays) {
    it(`red, untracked: ${path} - ${why}`, async () => {
      const result = await runGate(makeProject({ tests: { ...COVERED, [path]: PASSING_TEST } }));
      assert.notEqual(result.status, 0, show(result));
      assert.match(result.out, /GATE RED/);
      assert.ok(result.out.includes(path), `expected the output to name ${path}:\n${show(result)}`);
    });
  }
  for (const [path, why] of strays.slice(0, 5)) {
    it(`red, tracked: ${path} - ${why}`, async () => {
      const result = await runGate(makeProject({ tests: { ...COVERED, [path]: PASSING_TEST }, tracked: [path] }));
      assert.notEqual(result.status, 0, show(result));
      assert.match(result.out, /GATE RED/);
      assert.ok(result.out.includes(path), `expected the output to name ${path}:\n${show(result)}`);
    });
  }

  it('red in full mode too', async () => {
    const result = await runGate(makeProject({ tests: { ...COVERED, 'src/a/ui.test.tsx': PASSING_TEST } }), ['full']);
    assert.notEqual(result.status, 0, show(result));
    assert.ok(result.out.includes('src/a/ui.test.tsx'), show(result));
  });

  it('every stray file is named, not only the first', async () => {
    const result = await runGate(makeProject({
      tests: { ...COVERED, 'src/a/ui.test.tsx': PASSING_TEST, 'lib/foo.spec.ts': PASSING_TEST },
    }));
    assert.notEqual(result.status, 0, show(result));
    assert.ok(result.out.includes('src/a/ui.test.tsx'), show(result));
    assert.ok(result.out.includes('lib/foo.spec.ts'), show(result));
  });

  it('a stray test file does not stop the other gates from running', async () => {
    const result = await runGate(makeProject({ tests: { ...COVERED, 'lib/foo.spec.ts': PASSING_TEST } }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /PASS +script tests/);
    assert.match(result.out, /PASS +migrations/);
    assert.match(result.out, /PASS +no secrets/);
  });

  it('green: every test-named file matches one of the two globs, tracked or not', async () => {
    const tests = {
      'scripts/sample.test.mjs': PASSING_TEST,
      'scripts/hooks/deep.test.mjs': PASSING_TEST,
      'src/top.test.ts': PASSING_TEST,
      'src/services/deep/sync.test.ts': PASSING_TEST,
    };
    const result = await runGate(makeProject({ tests, tracked: ['scripts/sample.test.mjs', 'src/top.test.ts'] }));
    assert.ok(isGreen(result), show(result));
  });

  it('green: names that only look like tests are not test-named', async () => {
    const tests = {
      ...COVERED,
      'src/latest.ts': NO_TESTS,
      'src/testing/helper.ts': NO_TESTS,
      'src/tests.ts': NO_TESTS,
      'src/inspect.spec': NO_TESTS,
      'docs/test.md': '# notes\n',
    };
    const result = await runGate(makeProject({ tests }));
    assert.ok(isGreen(result), show(result));
  });

  it('green: Python files under e2e/ are exempt, whatever they are called', async () => {
    const tests = {
      ...COVERED,
      'e2e/rls_e2e.py': 'print("e2e")\n',
      'e2e/login.test.py': 'print("e2e")\n',
      'e2e/saas/tenant.spec.py': 'print("e2e")\n',
      'e2e/__tests__/helper.py': 'print("e2e")\n',
    };
    const result = await runGate(makeProject({ tests, tracked: ['e2e/login.test.py'] }));
    assert.ok(isGreen(result), show(result));
  });

  it('red: a Python test-named file outside e2e/ is not exempt', async () => {
    const result = await runGate(makeProject({ tests: { ...COVERED, 'tools/check.test.py': 'print("x")\n' } }));
    assert.notEqual(result.status, 0, show(result));
    assert.ok(result.out.includes('tools/check.test.py'), show(result));
  });

  it('green: git-ignored files are exempt (node_modules, dist)', async () => {
    const tests = {
      ...COVERED,
      'node_modules/pkg/index.test.js': PASSING_TEST,
      'node_modules/pkg/__tests__/a.js': PASSING_TEST,
      'dist/app.spec.js': PASSING_TEST,
    };
    const result = await runGate(makeProject({ tests, gitignore: 'node_modules/\ndist/\n' }));
    assert.ok(isGreen(result), show(result));
  });

  it('red: the same files when nothing ignores them', async () => {
    const tests = { ...COVERED, 'node_modules/pkg/index.test.js': PASSING_TEST };
    const result = await runGate(makeProject({ tests }));
    assert.notEqual(result.status, 0, show(result));
    assert.ok(result.out.includes('node_modules/pkg/index.test.js'), show(result));
  });

  it('red: a stray file that is ignored but was added to git anyway is tracked, so it counts', async () => {
    const dir = makeProject({ tests: { ...COVERED, 'vendor/x.test.js': PASSING_TEST }, gitignore: 'vendor/\n' });
    git(dir, 'add', '-f', '--', 'vendor/x.test.js');
    const result = await runGate(dir);
    assert.notEqual(result.status, 0, show(result));
    assert.ok(result.out.includes('vendor/x.test.js'), show(result));
  });

  it('red: a stray file whose name holds a space is still seen', async () => {
    const result = await runGate(makeProject({ tests: { ...COVERED, 'src/my notes.test.tsx': PASSING_TEST } }));
    assert.notEqual(result.status, 0, show(result));
    assert.ok(result.out.includes('my notes.test.tsx'), show(result));
  });
});

describe('P0-6: the gate runs e2e/target_selftest.py as "e2e targets staging only"', { concurrency: 4 }, () => {
  const FAIL_LINE = /FAIL +e2e targets staging only/;
  const PASS_LINE = /PASS +e2e targets staging only/;

  it('green when the self-test exits 0, and the script really ran', async () => {
    const dir = makeProject({ selftest: 0 });
    const result = await runGate(dir);
    assert.ok(isGreen(result), show(result));
    assert.match(result.out, PASS_LINE);
    assert.ok(existsSync(join(dir, SELFTEST_MARKER)), `e2e/target_selftest.py was not run:\n${show(result)}`);
  });

  for (const status of [1, 2, 3]) {
    it(`red when the self-test exits ${status}`, async () => {
      const dir = makeProject({ selftest: status });
      const result = await runGate(dir);
      assert.notEqual(result.status, 0, show(result));
      assert.match(result.out, /GATE RED/);
      assert.match(result.out, FAIL_LINE);
      assert.ok(!/GATE GREEN/.test(result.out), show(result));
      assert.ok(existsSync(join(dir, SELFTEST_MARKER)), `e2e/target_selftest.py was not run:\n${show(result)}`);
    });
  }

  it('red when e2e/target_selftest.py is missing: not skipped', async () => {
    const result = await runGate(makeProject({ selftest: null }));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /GATE RED/);
    assert.match(result.out, FAIL_LINE);
  });

  it('red when e2e/target_selftest.py does not parse', async () => {
    const dir = makeProject({ selftest: null, tests: { 'scripts/sample.test.mjs': PASSING_TEST, 'e2e/target_selftest.py': 'this is not ( python\n' } });
    const result = await runGate(dir);
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, FAIL_LINE);
  });

  it('it runs in full mode too', async () => {
    const dir = makeProject({ selftest: 1 });
    const result = await runGate(dir, ['full']);
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, FAIL_LINE);
  });

  it('a failing self-test does not stop the other gates, and a failing earlier gate does not skip it', async () => {
    const failing = await runGate(makeProject({ selftest: 1 }));
    assert.match(failing.out, /PASS +script tests/);
    assert.match(failing.out, /PASS +no secrets/);
    const dir = makeProject({ selftest: 0 });
    const lintRed = await runGate(dir, [], { STUB_LINT: '1' });
    assert.notEqual(lintRed.status, 0, show(lintRed));
    assert.match(lintRed.out, PASS_LINE);
    assert.ok(existsSync(join(dir, SELFTEST_MARKER)), show(lintRed));
  });
});

// ===========================================================================
// P0-9 (written before implementation)
// ===========================================================================

describe('P0-9 RF-055: with GATE_UNIT_TEST_CMD the verdict line says the unit tests were replaced', { concurrency: 4 }, () => {
  const REPLACED = (mode) => `GATE GREEN (${mode}; unit tests REPLACED by GATE_UNIT_TEST_CMD - not a real run)`;
  const lines = (text) => text.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
  const lastLine = (result) => lines(result.stdout).at(-1);
  /** No line anywhere in the output (stdout or stderr) is the plain green verdict. */
  const assertNoPlainGreen = (result) => {
    for (const line of lines(result.out)) {
      assert.ok(!/^\s*GATE GREEN \((quick|full)\)\s*$/.test(line), `the plain green line was printed:\n${show(result)}`);
    }
  };

  it('quick: the last line is exactly the REPLACED verdict', async () => {
    const result = await runGate(makeProject(), ['quick'], { GATE_UNIT_TEST_CMD: 'true' });
    assert.equal(result.status, 0, show(result));
    assert.equal(lastLine(result), REPLACED('quick'), show(result));
    assertNoPlainGreen(result);
  });

  it('no mode given: the quick form of the REPLACED verdict', async () => {
    const result = await runGate(makeProject(), [], { GATE_UNIT_TEST_CMD: 'true' });
    assert.equal(result.status, 0, show(result));
    assert.equal(lastLine(result), REPLACED('quick'), show(result));
    assertNoPlainGreen(result);
  });

  it('full: the last line is exactly the REPLACED verdict with "full;"', async () => {
    const result = await runGate(makeProject(), ['full'], { GATE_UNIT_TEST_CMD: 'true' });
    assert.equal(result.status, 0, show(result));
    assert.equal(lastLine(result), REPLACED('full'), show(result));
    assertNoPlainGreen(result);
  });

  it('the output holds exactly one GATE GREEN line, and it is the REPLACED one', async () => {
    for (const mode of ['quick', 'full']) {
      const result = await runGate(makeProject(), [mode], { GATE_UNIT_TEST_CMD: 'true' });
      const green = lines(result.out).filter((line) => line.includes('GATE GREEN'));
      assert.deepEqual(green, [REPLACED(mode)], show(result));
    }
  });

  for (const [cmd, why] of [
    [':', 'the shell no-op'],
    ['echo unit tests skipped', 'a command that prints something'],
    ['true # not a real run', 'a command with a comment'],
    ['exit 0', 'a command that exits the step'],
  ]) {
    it(`whatever the replacement command is: ${JSON.stringify(cmd)} - ${why}`, async () => {
      const result = await runGate(makeProject(), ['quick'], { GATE_UNIT_TEST_CMD: cmd });
      assert.equal(lastLine(result), REPLACED('quick'), show(result));
      assertNoPlainGreen(result);
    });
  }

  it('a replacement command that prints the plain green line itself does not make it the verdict', async () => {
    const result = await runGate(makeProject(), ['quick'], { GATE_UNIT_TEST_CMD: 'echo "GATE GREEN (quick)"' });
    assert.equal(lastLine(result), REPLACED('quick'), show(result));
  });

  it('a failing replacement is red: no green line of either kind', async () => {
    for (const mode of ['quick', 'full']) {
      const result = await runGate(makeProject(), [mode], { GATE_UNIT_TEST_CMD: 'false' });
      assert.notEqual(result.status, 0, show(result));
      assert.match(result.out, /GATE RED/);
      assert.ok(!/GATE GREEN/.test(result.out), show(result));
    }
  });

  it('another gate failing while the unit tests are replaced is red: no green line of either kind', async () => {
    const result = await runGate(makeProject({ secrets: 1 }), ['quick'], { GATE_UNIT_TEST_CMD: 'true' });
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /GATE RED/);
    assert.ok(!/GATE GREEN/.test(result.out), show(result));
  });

  it('an unset or empty GATE_UNIT_TEST_CMD is not a replacement: the REPLACED verdict is not printed', async () => {
    // The fixture has no tsx, so the real unit-test step fails and the gate is
    // red (RF-044); the point here is only that the REPLACED wording is absent.
    for (const value of [null, '']) {
      const result = await runGate(makeProject(), ['quick'], { GATE_UNIT_TEST_CMD: value });
      assert.ok(!result.out.includes('REPLACED'), show(result));
      assert.ok(!/GATE GREEN/.test(result.out), show(result));
    }
  });
});

// ===========================================================================
// P0-10 (written before implementation)
// ===========================================================================

// RF-059: checking out a branch that predates the tooling replaces the
// git-ignored staging link with the tracked production link. The gate is the
// backstop: "working copy is not linked to production" fails when
// supabase/.temp/project-ref equals PROD_REF from scripts/hooks/guard.conf,
// passes when the file is absent or holds any other ref, and fails when
// guard.conf cannot be read. The refs are invented.
describe('P0-10 RF-059: the gate "working copy is not linked to production"', { concurrency: 4 }, () => {
  const FAIL_LINE = /^FAIL +working copy is not linked to production\s*$/m;
  const PASS_LINE = /^PASS +working copy is not linked to production\s*$/m;
  const OTHER_REF = 'otherrefotherrefother1';

  const assertPasses = (result) => {
    assert.match(result.out, PASS_LINE, show(result));
    assert.ok(!FAIL_LINE.test(result.out), show(result));
    assert.ok(isGreen(result), show(result));
  };
  const assertFails = (result) => {
    assert.match(result.out, FAIL_LINE, show(result));
    assert.ok(!PASS_LINE.test(result.out), show(result));
    assert.notEqual(result.status, 0, show(result));
    assert.match(result.out, /GATE RED/);
    assert.match(result.out, /GATE RED[^\n]*working copy is not linked to production/, 'the red verdict names the gate');
    assert.ok(!/GATE GREEN/.test(result.out), show(result));
  };

  for (const [why, link] of [
    ['no link file at all', null],
    ['the link file holds the staging ref', FIXTURE_STAGING],
    ['the link file holds the staging ref and a newline', `${FIXTURE_STAGING}\n`],
    ['the link file holds a third project', OTHER_REF],
    ['the link file is empty', ''],
    ['the link file holds a ref that only starts with the production ref', `${FIXTURE_PROD}x`],
    ['the link file holds a ref that is only the start of the production ref', FIXTURE_PROD.slice(0, -1)],
  ]) {
    it(`PASS and the gate is green: ${why}`, async () => {
      assertPasses(await runGate(makeProject({ link })));
    });
  }

  it('PASS when supabase/.temp exists without a project-ref file', async () => {
    const dir = makeProject();
    mkdirSync(join(dir, 'supabase', '.temp'), { recursive: true });
    assertPasses(await runGate(dir));
  });

  for (const [why, link] of [
    ['the link file is exactly the production ref', FIXTURE_PROD],
    ['the production ref and a newline', `${FIXTURE_PROD}\n`],
    ['the production ref and a Windows line ending', `${FIXTURE_PROD}\r\n`],
    ['the production ref with blanks around it', `  ${FIXTURE_PROD} \t\n`],
    ['the production ref after an empty line', `\n${FIXTURE_PROD}\n`],
    ['the production ref in upper case', FIXTURE_PROD.toUpperCase()],
    ['the production ref in upper case with a newline', `${FIXTURE_PROD.toUpperCase()}\n`],
  ]) {
    it(`FAIL and the gate is red: ${why}`, async () => {
      assertFails(await runGate(makeProject({ link })));
    });
  }

  // P0-11 RF-065: "the production-link gate compares each non-empty line of
  // the link file, trimmed, case-insensitively: if any line equals PROD_REF
  // the gate is red." No earlier row contradicts this; the rows above with
  // blanks and an empty first line stay as they were.
  for (const [why, link] of [
    ['another ref on the first line and the production ref on a later line', `${OTHER_REF}\n${FIXTURE_PROD}\n`],
    ['the staging ref first, the production ref second, no final newline', `${FIXTURE_STAGING}\n${FIXTURE_PROD}`],
    ['the production ref on the first line followed by another ref', `${FIXTURE_PROD}\n${OTHER_REF}\n`],
    ['the production ref with blanks around it on a later line', `${OTHER_REF}\n  \t${FIXTURE_PROD} \t \n`],
    ['the production ref in upper case on a later line', `${OTHER_REF}\n${FIXTURE_PROD.toUpperCase()}\n`],
    ['the production ref on the third line after an empty one', `${OTHER_REF}\n\n${FIXTURE_PROD}\n`],
    ['the production ref on a later line with Windows line endings', `${OTHER_REF}\r\n${FIXTURE_PROD}\r\n`],
    ['the production ref between two other refs', `${OTHER_REF}\n${FIXTURE_PROD}\n${FIXTURE_STAGING}\n`],
  ]) {
    it(`P0-11 RF-065: FAIL and the gate is red: ${why}`, async () => {
      assertFails(await runGate(makeProject({ link })));
    });
  }

  for (const [why, link] of [
    ['two lines, neither equal to the production ref', `${OTHER_REF}\n${FIXTURE_STAGING}\n`],
    ['two lines that only resemble the production ref', `${FIXTURE_PROD}x\n${FIXTURE_PROD.slice(0, -1)}\n`],
    ['the production ref split over two lines', `${FIXTURE_PROD.slice(0, 10)}\n${FIXTURE_PROD.slice(10)}\n`],
    ['a line that holds the production ref and another word', `${OTHER_REF}\n${FIXTURE_PROD} ${OTHER_REF}\n`],
    ['only empty lines', '\n\n\n'],
  ]) {
    it(`P0-11 RF-065: PASS and the gate is green: ${why}`, async () => {
      assertPasses(await runGate(makeProject({ link })));
    });
  }

  // P0-12 RF-068: a line equal to the production ref after trimming ALL
  // whitespace, form feed and vertical tab included, and after removing a
  // leading UTF-8 BOM, is red. No earlier row contradicts this.
  const BOM = '﻿'; // written as EF BB BF
  for (const [why, link] of [
    ['a form feed before the production ref', `\f${FIXTURE_PROD}`],
    ['a vertical tab after the production ref', `${FIXTURE_PROD}\v`],
    ['a form feed before and a vertical tab after, with a newline', `\f${FIXTURE_PROD}\v\n`],
    ['a UTF-8 BOM before the production ref', `${BOM}${FIXTURE_PROD}`],
    ['a UTF-8 BOM before the production ref and a newline', `${BOM}${FIXTURE_PROD}\n`],
    ['a UTF-8 BOM, then a form feed, then the production ref', `${BOM}\f${FIXTURE_PROD}\n`],
    ['a UTF-8 BOM alone on the first line and the production ref on the second', `${BOM}\n${FIXTURE_PROD}\n`],
    ['a UTF-8 BOM and another ref on the first line, the production ref on the second', `${BOM}${OTHER_REF}\n${FIXTURE_PROD}\n`],
    ['another ref first, then the production ref between a form feed and a vertical tab', `${OTHER_REF}\n\f${FIXTURE_PROD}\v\n`],
    ['a UTF-8 BOM before the production ref in upper case', `${BOM}${FIXTURE_PROD.toUpperCase()}\n`],
  ]) {
    it(`P0-12 RF-068: FAIL and the gate is red: ${why}`, async () => {
      assertFails(await runGate(makeProject({ link })));
    });
  }

  for (const [why, link] of [
    ['a form feed before another ref', `\f${OTHER_REF}`],
    ['a vertical tab after another ref', `${OTHER_REF}\v`],
    ['a UTF-8 BOM before another ref', `${BOM}${OTHER_REF}`],
    ['a UTF-8 BOM on the first line and the staging ref on the second', `${BOM}\n${FIXTURE_STAGING}\n`],
    ['a UTF-8 BOM, a form feed and a ref that only starts with the production ref', `${BOM}\f${FIXTURE_PROD}x\v\n`],
    ['only a UTF-8 BOM, a form feed and a vertical tab', `${BOM}\f\v\n`],
  ]) {
    it(`P0-12 RF-068: PASS and the gate is green: ${why}`, async () => {
      assertPasses(await runGate(makeProject({ link })));
    });
  }

  it('FAIL in full mode too', async () => {
    assertFails(await runGate(makeProject({ link: FIXTURE_PROD }), ['full']));
  });

  it('PASS in full mode when the link is staging', async () => {
    assertPasses(await runGate(makeProject({ link: FIXTURE_STAGING }), ['full']));
  });

  it('the production ref is whatever guard.conf says, not a fixed value', async () => {
    const conf = `PROD_REF=${OTHER_REF}\nSTAGING_REF=${FIXTURE_STAGING}\n`;
    assertFails(await runGate(makeProject({ guardConf: conf, link: OTHER_REF })));
    assertPasses(await runGate(makeProject({ guardConf: conf, link: FIXTURE_PROD })));
  });

  // guard.conf's own header: KEY=value lines; '#' starts a comment at the
  // start of a line or after blanks following a value. The Bash guard also
  // reads a quoted value and Windows line endings (guard-bash.test.mjs,
  // ruling (e)); the gate must not be the one reader that misses them.
  for (const [why, conf] of [
    ['a comment after the value', `PROD_REF=${FIXTURE_PROD}   # production\nSTAGING_REF=\n`],
    ['a double-quoted value', `PROD_REF="${FIXTURE_PROD}"\nSTAGING_REF=\n`],
    ['a single-quoted value', `PROD_REF='${FIXTURE_PROD}'\nSTAGING_REF=\n`],
    ['Windows line endings', `PROD_REF=${FIXTURE_PROD}\r\nSTAGING_REF=\r\n`],
    ['no STAGING_REF line at all', `PROD_REF=${FIXTURE_PROD}\n`],
    ['a commented-out PROD_REF line before the real one', `# PROD_REF=${OTHER_REF}\nPROD_REF=${FIXTURE_PROD}\n`],
    ['no newline at the end of the file', `STAGING_REF=\nPROD_REF=${FIXTURE_PROD}`],
  ]) {
    it(`FAIL when linked to production and guard.conf has ${why}`, async () => {
      assertFails(await runGate(makeProject({ guardConf: conf, link: FIXTURE_PROD })));
    });
  }

  for (const [why, conf] of [
    ['guard.conf is missing', null],
    ['guard.conf is empty', ''],
    ['guard.conf has no PROD_REF line', `STAGING_REF=${FIXTURE_STAGING}\n`],
    ['PROD_REF is empty', `PROD_REF=\nSTAGING_REF=${FIXTURE_STAGING}\n`],
    ['PROD_REF is only commented out', `# PROD_REF=${FIXTURE_PROD}\nSTAGING_REF=${FIXTURE_STAGING}\n`],
    ['only a key that ends in PROD_REF is set', `NOT_PROD_REF=${FIXTURE_PROD}\nSTAGING_REF=${FIXTURE_STAGING}\n`],
  ]) {
    for (const [linkWhy, link] of [['no link file', null], ['a staging link', FIXTURE_STAGING], ['a production link', FIXTURE_PROD]]) {
      it(`FAIL when ${why} (${linkWhy}): the check cannot tell, so it is not a pass`, async () => {
        assertFails(await runGate(makeProject({ guardConf: conf, link })));
      });
    }
  }

  it('FAIL when guard.conf exists but cannot be read', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, async () => {
    const dir = makeProject({ link: null });
    chmodSync(join(dir, 'scripts', 'hooks', 'guard.conf'), 0o000);
    try {
      assertFails(await runGate(dir));
    } finally {
      chmodSync(join(dir, 'scripts', 'hooks', 'guard.conf'), 0o644);
    }
  });

  it('a production link does not stop the other gates from running', async () => {
    const result = await runGate(makeProject({ link: FIXTURE_PROD }));
    assert.match(result.out, /PASS +typecheck/);
    assert.match(result.out, /PASS +unit tests/);
    assert.match(result.out, /PASS +script tests/);
    assert.match(result.out, /PASS +migrations/);
    assert.match(result.out, /PASS +no secrets/);
    assert.match(result.out, /PASS +e2e targets staging only/);
    assert.match(result.out, /GATE RED \(quick\): 1 failed/);
  });

  it('an earlier failing gate does not skip it, either way', async () => {
    const linked = await runGate(makeProject({ link: FIXTURE_PROD }), [], { STUB_LINT: '1' });
    assert.match(linked.out, FAIL_LINE, show(linked));
    assert.match(linked.out, /GATE RED \(quick\): 2 failed/);
    const clean = await runGate(makeProject({ link: FIXTURE_STAGING }), [], { STUB_LINT: '1' });
    assert.match(clean.out, PASS_LINE, show(clean));
    assert.notEqual(clean.status, 0, show(clean));
  });

  it('the gate reads the link file; it does not change or remove it', async () => {
    const dir = makeProject({ link: `${FIXTURE_PROD}\n` });
    await runGate(dir);
    assert.equal(readFileSync(join(dir, 'supabase', '.temp', 'project-ref'), 'utf8'), `${FIXTURE_PROD}\n`);
    assert.equal(readFileSync(join(dir, 'scripts', 'hooks', 'guard.conf'), 'utf8'), DEFAULT_GUARD_CONF);
  });
});
