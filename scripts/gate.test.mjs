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
// Run: node --test "scripts/**/*.test.mjs"

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

/**
 * A project directory holding a copy of the real gate.sh.
 * `tests` maps paths to file contents; `migrations` and `secrets` are the exit
 * statuses of the stub checks.
 */
function makeProject({ tests = { 'scripts/sample.test.mjs': PASSING_TEST }, migrations = 0, secrets = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'));
  TEMP_DIRS.push(dir);
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
  for (const [path, content] of Object.entries(tests)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Run the copied gate. Resolves with exit status, output and the stub npm's log lines. */
function runGate(dir, args = [], stub = {}) {
  const env = { ...process.env };
  // Set by the test runner this file runs under; with it, a nested
  // `node --test` reports to its parent instead of printing a summary.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const log = join(dir, 'npm.log');
  return new Promise((resolve) => {
    execFile(
      join(dir, 'scripts', 'gate.sh'),
      args,
      { env: { ...env, ...stub, PATH: `${join(dir, 'bin')}:${env.PATH}`, STUB_NPM_LOG: log }, encoding: 'utf8', timeout: 120000 },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        const npm = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
        resolve({ status, out: `${stdout}${stderr}`, npm });
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

  it('the stub npm is the one the gate ran', async () => {
    const result = await runGate(makeProject());
    assert.ok(result.npm.some((line) => /\blint\b/.test(line)), `no lint call was logged: ${result.npm.join(' | ')}`);
    assert.ok(result.npm.some((line) => /\btest\b/.test(line)), `no test call was logged: ${result.npm.join(' | ')}`);
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
    ['the unit tests fail', {}, { STUB_UNIT: '1' }, /FAIL +unit tests/],
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
