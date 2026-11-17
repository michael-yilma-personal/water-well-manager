// P0-9: the management scripts (scripts/create-user.sh,
// scripts/delete-test-data.sh, scripts/check-attribution.sh) and the target
// check they share (scripts/lib/project-target.sh).
//
// Derived from "P0-9 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// (last bullet) and "P0-3 acceptance criteria" (no default project; the
// production ref is refused unless --production is the first argument).
//
// Nothing here can reach a real project:
//   - the scripts are copied into a throwaway scripts/ tree whose
//     scripts/hooks/guard.conf names an invented production ref;
//   - stub `curl`, `security` and `supabase` executables come first on PATH.
//     Each writes a marker file and exits 1. Every test asserts afterwards
//     that the marker does not exist: a script that got as far as a network or
//     keychain call fails the test;
//   - the refs are invented; no real project ref appears in this file.
//
// Run: node --test "scripts/**/*.test.mjs"

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PROD = 'prodrefprodrefprodref1';
const STAGING = 'stagingrefstagingref1';
const OTHER = 'otherrefotherrefother1';

const SCRIPTS = ['create-user.sh', 'delete-test-data.sh', 'check-attribution.sh'];
/** Arguments each script accepts as a complete, harmless call. */
const VALID_ARGS = {
  'create-user.sh': ['a@example.com', 'a-strong-password'],
  'delete-test-data.sh': [],
  'check-attribution.sh': [],
};

const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      chmodSync(join(dir, 'scripts', 'hooks', 'guard.conf'), 0o644);
    } catch {
      // not a file, or not there: nothing to restore
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const DEFAULT_CONF = `PROD_REF=${PROD}\nSTAGING_REF=${STAGING}\n`;

/**
 * A throwaway project: copies of the three scripts and scripts/lib/, a fake
 * scripts/hooks/guard.conf, and bin/ with the stubs. `conf` is the content of
 * guard.conf; null leaves the file out.
 */
function makeFixture({ conf = DEFAULT_CONF } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mgmt-scripts-test-'));
  TEMP_DIRS.push(dir);
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  for (const name of SCRIPTS) {
    copyFileSync(join(HERE, name), join(dir, 'scripts', name));
    chmodSync(join(dir, 'scripts', name), 0o755);
  }
  copyFileSync(join(HERE, 'lib', 'project-target.sh'), join(dir, 'scripts', 'lib', 'project-target.sh'));
  if (conf !== null) writeFileSync(join(dir, 'scripts', 'hooks', 'guard.conf'), conf);
  const marker = join(dir, 'network.called');
  for (const tool of ['curl', 'security', 'supabase']) {
    writeFileSync(join(dir, 'bin', tool), `#!/bin/bash\necho "${tool} $*" >> '${marker}'\nexit 1\n`);
    chmodSync(join(dir, 'bin', tool), 0o755);
  }
  return { dir, marker };
}

const SHARED = makeFixture();
const FIXTURES_IN_USE = new Set([SHARED]);

afterEach(() => {
  // Belt and braces: every run() asserts this already.
  for (const fixture of FIXTURES_IN_USE) {
    const called = existsSync(fixture.marker);
    if (called) rmSync(fixture.marker, { force: true });
    assert.ok(!called, 'a stub curl/security/supabase was called during the test');
  }
});

/**
 * Run one script of a fixture. `ref` is SUPABASE_PROJECT_REF (null: unset).
 * `dry` is DRILL_SCRIPT_DRY_RUN (null: unset). Fails the test when a stub ran.
 */
function run(script, args = [], { ref = STAGING, dry = '1', fixture = SHARED, env = {}, cwd = undefined } = {}) {
  FIXTURES_IN_USE.add(fixture);
  const base = {
    PATH: `${join(fixture.dir, 'bin')}:/usr/bin:/bin`,
    HOME: fixture.dir,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
  if (ref !== null) base.SUPABASE_PROJECT_REF = ref;
  if (dry !== null) base.DRILL_SCRIPT_DRY_RUN = dry;
  const result = spawnSync(join(fixture.dir, 'scripts', script), args, {
    cwd: cwd ?? fixture.dir,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
  const called = existsSync(fixture.marker);
  if (called) rmSync(fixture.marker, { force: true });
  assert.ok(
    !called,
    `${script} ${JSON.stringify(args)} reached a network or keychain call (stub ran)\nexit ${result.status}\n${result.stdout}${result.stderr}`,
  );
  return result;
}

const show = (result) => `exit ${result.status}${result.error ? ` (${result.error.message})` : ''}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;

/** The script stopped with exit 2 and one message on stderr, and did not announce a run. */
function assertRefused(result, messagePattern = null) {
  assert.equal(result.status, 2, show(result));
  assert.notEqual(result.stderr.trim(), '', `expected a message on stderr\n${show(result)}`);
  assert.ok(!result.stdout.includes('would run against'), show(result));
  if (messagePattern) assert.match(result.stderr, messagePattern, show(result));
}

/** The script passed every check and stopped at the dry-run point for `ref`. */
function assertWouldRun(result, ref) {
  assert.equal(result.status, 0, show(result));
  assert.equal(result.stdout, `would run against ${ref}\n`, show(result));
}

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

describe('fixture: the stubs come first on PATH and a dry run stops before them', () => {
  it('the stub curl is the one a script would find', () => {
    const fixture = makeFixture();
    const result = spawnSync('/bin/bash', ['-c', 'command -v curl; command -v security; command -v supabase'], {
      env: { PATH: `${join(fixture.dir, 'bin')}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    assert.deepEqual(result.stdout.trim().split('\n'), ['curl', 'security', 'supabase'].map((tool) => join(fixture.dir, 'bin', tool)));
  });

  it('the marker appears when a stub is called (so its absence means something)', () => {
    const fixture = makeFixture();
    spawnSync(join(fixture.dir, 'bin', 'curl'), ['-s', 'http://127.0.0.1:9/'], { encoding: 'utf8' });
    assert.ok(existsSync(fixture.marker));
  });

  for (const script of SCRIPTS) {
    it(`${script}: a dry run against a non-production ref prints "would run against <ref>" and exits 0`, () => {
      assertWouldRun(run(script, VALID_ARGS[script], { ref: STAGING }), STAGING);
      assertWouldRun(run(script, VALID_ARGS[script], { ref: OTHER }), OTHER);
    });
  }
});

// ---------------------------------------------------------------------------
// No ref: there is no default project
// ---------------------------------------------------------------------------

describe('no project ref: every script stops (exit 2), there is no default project', () => {
  for (const script of SCRIPTS) {
    it(`${script}: SUPABASE_PROJECT_REF unset`, () => {
      assertRefused(run(script, VALID_ARGS[script], { ref: null }), /SUPABASE_PROJECT_REF/);
    });
    it(`${script}: SUPABASE_PROJECT_REF set to the empty string`, () => {
      assertRefused(run(script, VALID_ARGS[script], { ref: '' }), /SUPABASE_PROJECT_REF/);
    });
    it(`${script}: unset, with --production first`, () => {
      assertRefused(run(script, ['--production', ...VALID_ARGS[script]], { ref: null }), /SUPABASE_PROJECT_REF/);
    });
    it(`${script}: unset, and no dry-run switch either - still stops before any network call`, () => {
      assertRefused(run(script, VALID_ARGS[script], { ref: null, dry: null }), /SUPABASE_PROJECT_REF/);
    });
    it(`${script}: a ref passed as an argument is not a project ref`, () => {
      const result = run(script, [STAGING, ...VALID_ARGS[script]], { ref: null });
      assertRefused(result, /SUPABASE_PROJECT_REF/);
    });
  }
});

describe('a project ref that is not a plain word is refused (exit 2)', () => {
  const hostile = [
    ['two words', 'a space'],
    [`${STAGING}/../${PROD}`, 'a path that leads to another project'],
    [`${STAGING}.supabase.co`, 'a host name'],
    [`${STAGING};id`, 'a shell metacharacter'],
    [`${STAGING}'`, 'a single quote'],
    ['$(id)', 'a command substitution'],
    [`${STAGING}\n${PROD}`, 'a line break'],
    [`${STAGING}?x=1`, 'a query string'],
    [' ', 'only a blank'],
  ];
  for (const script of SCRIPTS) {
    for (const [ref, why] of hostile) {
      it(`${script}: ${JSON.stringify(ref)} - ${why}`, () => {
        assertRefused(run(script, VALID_ARGS[script], { ref }));
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The production ref
// ---------------------------------------------------------------------------

describe('the production ref without --production is refused (exit 2)', () => {
  for (const script of SCRIPTS) {
    it(`${script}: plain call`, () => {
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD }), /production/i);
    });
    it(`${script}: without the dry-run switch - still stops before any network call`, () => {
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD, dry: null }), /production/i);
    });
    it(`${script}: the production ref in upper case`, () => {
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD.toUpperCase() }), /production/i);
    });
    it(`${script}: the production ref in mixed case`, () => {
      const mixed = PROD.slice(0, 5).toUpperCase() + PROD.slice(5);
      assertRefused(run(script, VALID_ARGS[script], { ref: mixed }), /production/i);
    });
    it(`${script}: a look-alike of the flag is not the flag`, () => {
      for (const flag of ['--prod', '--Production', '-production', '--production=1', 'production', '--production ']) {
        assertRefused(run(script, [flag, ...VALID_ARGS[script]], { ref: PROD }));
      }
    });
    it(`${script}: --production given in the environment, not as an argument`, () => {
      const env = { PRODUCTION: '1', DRILL_PRODUCTION: '1', PROJECT_TARGET_SHIFT: '1' };
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD, env }), /production/i);
    });
  }
  it('delete-test-data.sh: with --yes', () => {
    assertRefused(run('delete-test-data.sh', ['--yes'], { ref: PROD }), /production/i);
  });
  it('check-attribution.sh: with --fix', () => {
    assertRefused(run('check-attribution.sh', ['--fix'], { ref: PROD }), /production/i);
  });
  it('create-user.sh: with every argument given', () => {
    const args = ['boss@example.com', 'a-strong-password', 'Administrator', 'David Mutua', 'ADM-001'];
    assertRefused(run('create-user.sh', args, { ref: PROD }), /production/i);
  });
});

describe('the production ref with --production as the first argument passes the target check', () => {
  for (const script of SCRIPTS) {
    it(`${script}: --production first`, () => {
      assertWouldRun(run(script, ['--production', ...VALID_ARGS[script]], { ref: PROD }), PROD);
    });
  }
  it('delete-test-data.sh --production --yes a@example.com', () => {
    assertWouldRun(run('delete-test-data.sh', ['--production', '--yes', 'a@example.com'], { ref: PROD }), PROD);
  });
  it('check-attribution.sh --production --fix', () => {
    assertWouldRun(run('check-attribution.sh', ['--production', '--fix'], { ref: PROD }), PROD);
  });
  it('create-user.sh --production with every argument given', () => {
    const args = ['--production', 'boss@example.com', 'a-strong-password', 'Administrator', 'David Mutua', 'ADM-001'];
    assertWouldRun(run('create-user.sh', args, { ref: PROD }), PROD);
  });
  it('--production does not lift the other checks: the delete script still refuses a real address', () => {
    assertRefused(run('delete-test-data.sh', ['--production', '--yes', 'boss@company.com'], { ref: PROD }));
  });
  it('--production does not lift the other checks: the create script still refuses a quote', () => {
    assertRefused(run('create-user.sh', ['--production', 'a@example.com', "pass'word"], { ref: PROD }));
  });
});

describe('--production anywhere but first does not open production (exit 2)', () => {
  const rows = [
    ['create-user.sh', ['a@example.com', 'a-strong-password', '--production'], 'after the password'],
    ['create-user.sh', ['a@example.com', '--production', 'a-strong-password'], 'between email and password'],
    ['create-user.sh', ['a@example.com', 'a-strong-password', 'Driller', 'A Name', 'B-1', '--production'], 'as the last of six arguments'],
    ['delete-test-data.sh', ['--yes', '--production'], 'after --yes'],
    ['delete-test-data.sh', ['a@example.com', '--production'], 'after an address'],
    ['delete-test-data.sh', ['--yes', 'a@example.com', '--production'], 'last'],
    ['check-attribution.sh', ['--fix', '--production'], 'after --fix'],
    ['create-user.sh', ['', '--production', 'a@example.com', 'a-strong-password'], 'after an empty first argument'],
    ['delete-test-data.sh', ['', '--production'], 'after an empty first argument'],
    ['check-attribution.sh', ['', '--production'], 'after an empty first argument'],
  ];
  for (const [script, args, why] of rows) {
    it(`production ref: ${script} ${JSON.stringify(args)} - ${why}`, () => {
      assertRefused(run(script, args, { ref: PROD }));
    });
    it(`production ref, no dry-run switch: ${script} ${JSON.stringify(args)} - ${why}`, () => {
      assertRefused(run(script, args, { ref: PROD, dry: null }));
    });
  }

  it('staging ref: delete-test-data.sh refuses a --production that is not first', () => {
    assertRefused(run('delete-test-data.sh', ['--yes', '--production'], { ref: STAGING }), /--production/);
    assertRefused(run('delete-test-data.sh', ['a@example.com', '--production'], { ref: STAGING }), /--production/);
  });
  it('staging ref: check-attribution.sh refuses a --production that is not first', () => {
    assertRefused(run('check-attribution.sh', ['--fix', '--production'], { ref: STAGING }));
  });
  it('staging ref: create-user.sh does not run with --production where the role belongs', () => {
    const result = run('create-user.sh', ['a@example.com', 'a-strong-password', '--production'], { ref: STAGING });
    assert.notEqual(result.status, 0, show(result));
    assert.ok(!result.stdout.includes('would run against'), show(result));
  });
});

// ---------------------------------------------------------------------------
// guard.conf
// ---------------------------------------------------------------------------

describe('a guard.conf that cannot give a production ref stops every script (exit 2)', () => {
  const confs = [
    [null, 'the file is missing'],
    ['', 'the file is empty'],
    ['# nothing here\n', 'only a comment'],
    [`STAGING_REF=${STAGING}\n`, 'no PROD_REF line'],
    ['PROD_REF=\n', 'PROD_REF is empty'],
    ['PROD_REF=   \n', 'PROD_REF is blank'],
    ['PROD_REF= # the production project\n', 'PROD_REF is only a comment'],
    [`#PROD_REF=${PROD}\n`, 'PROD_REF is commented out'],
    ['PROD_REF=not a ref\n', 'PROD_REF holds a space'],
    ['PROD_REF=abc/def\n', 'PROD_REF holds a slash'],
    ['PROD_REF=$(cat ref.txt)\n', 'PROD_REF is shell code, not a value'],
    [`PROD_REF=${PROD}\nPROD_REF=\n`, 'a later empty PROD_REF: the last assignment wins'],
    ['\x00\x01\x02 binary\n', 'not a text file'],
  ];
  for (const script of SCRIPTS) {
    for (const [conf, why] of confs) {
      it(`${script}: ${why}`, () => {
        const fixture = makeFixture({ conf });
        assertRefused(run(script, VALID_ARGS[script], { ref: STAGING, fixture }), /guard\.conf/);
        assertRefused(run(script, VALID_ARGS[script], { ref: PROD, fixture }), /guard\.conf/);
        assertRefused(run(script, ['--production', ...VALID_ARGS[script]], { ref: PROD, fixture }), /guard\.conf/);
        assertRefused(run(script, VALID_ARGS[script], { ref: STAGING, dry: null, fixture }), /guard\.conf/);
      });
    }

    it(`${script}: guard.conf is a directory`, () => {
      const fixture = makeFixture({ conf: null });
      mkdirSync(join(fixture.dir, 'scripts', 'hooks', 'guard.conf'));
      assertRefused(run(script, VALID_ARGS[script], { ref: STAGING, fixture }), /guard\.conf/);
      assertRefused(run(script, ['--production', ...VALID_ARGS[script]], { ref: PROD, fixture }), /guard\.conf/);
    });

    it(`${script}: guard.conf exists but cannot be read (mode 000)`, (t) => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('running as root: every file is readable');
        return;
      }
      const fixture = makeFixture();
      chmodSync(join(fixture.dir, 'scripts', 'hooks', 'guard.conf'), 0o000);
      assertRefused(run(script, VALID_ARGS[script], { ref: STAGING, fixture }), /guard\.conf/);
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD, fixture }), /guard\.conf/);
      assertRefused(run(script, ['--production', ...VALID_ARGS[script]], { ref: PROD, fixture }), /guard\.conf/);
    });

    it(`${script}: the scripts/hooks directory is missing`, () => {
      const fixture = makeFixture({ conf: null });
      rmSync(join(fixture.dir, 'scripts', 'hooks'), { recursive: true });
      assertRefused(run(script, VALID_ARGS[script], { ref: STAGING, fixture }), /guard\.conf/);
    });
  }
});

describe('PROD_REF is read the way the guard hook reads guard.conf', () => {
  const confs = [
    [`PROD_REF=${PROD} # the production project\nSTAGING_REF=${STAGING}\n`, 'a comment after the value'],
    [`PROD_REF=${PROD}\t# production\n`, 'a comment after a tab'],
    [`PROD_REF="${PROD}"\n`, 'a double-quoted value'],
    [`PROD_REF='${PROD}'\n`, 'a single-quoted value'],
    [`  PROD_REF = ${PROD}  \n`, 'blanks around the key and the value'],
    [`# header\n\nSTAGING_REF=${STAGING}\nPROD_REF=${PROD}\n`, 'after comments, a blank line and another key'],
    [`PROD_REF=${PROD}`, 'no newline at the end of the file'],
    [`PROD_REF=${PROD}\r\n`, 'a Windows line ending'],
    [`PROD_REF=${OTHER}\nPROD_REF=${PROD}\n`, 'set twice: the last assignment wins'],
  ];
  for (const [conf, why] of confs) {
    it(`production is still refused, and staging still passes: ${why}`, () => {
      const fixture = makeFixture({ conf });
      for (const script of SCRIPTS) {
        const refused = run(script, VALID_ARGS[script], { ref: PROD, fixture });
        assert.equal(refused.status, 2, `${script}\n${show(refused)}`);
        assert.ok(!refused.stdout.includes('would run against'), `${script}\n${show(refused)}`);
        assertWouldRun(run(script, VALID_ARGS[script], { ref: STAGING, fixture }), STAGING);
      }
    });
  }
});

describe('guard.conf is the one next to the script, whatever the caller sets', () => {
  /** A second tree whose guard.conf calls a different project production. */
  const decoy = makeFixture({ conf: `PROD_REF=${OTHER}\n` });

  for (const script of SCRIPTS) {
    it(`${script}: run from inside another project tree, production is still the script's own PROD_REF`, () => {
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD, cwd: decoy.dir }), /production/i);
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD, cwd: join(decoy.dir, 'scripts') }), /production/i);
    });
    it(`${script}: environment variables cannot rename production`, () => {
      const env = {
        PROD_REF: OTHER,
        STAGING_REF: PROD,
        PROJECT_TARGET_CONF: join(decoy.dir, 'scripts', 'hooks', 'guard.conf'),
        CLAUDE_PROJECT_DIR: decoy.dir,
        PROJECT_REF: STAGING,
      };
      assertRefused(run(script, VALID_ARGS[script], { ref: PROD, env }), /production/i);
    });
    it(`${script}: run through a relative path from another directory`, () => {
      const result = spawnSync('/bin/bash', ['-c', `cd '${join(SHARED.dir, 'scripts')}' && ./${script} "$@"`, 'sh', ...VALID_ARGS[script]], {
        env: { PATH: `${join(SHARED.dir, 'bin')}:/usr/bin:/bin`, HOME: SHARED.dir, SUPABASE_PROJECT_REF: PROD, DRILL_SCRIPT_DRY_RUN: '1' },
        encoding: 'utf8',
        timeout: 15000,
      });
      assertRefused(result, /production/i);
    });
  }
});

// ---------------------------------------------------------------------------
// delete-test-data.sh: only @example.com accounts
// ---------------------------------------------------------------------------

describe('delete-test-data.sh refuses any address that is not @example.com (exit 2)', () => {
  const bad = [
    ['boss@company.com', 'a real address'],
    ['owner@drill.example', 'another domain'],
    ['a@example.org', 'example.org'],
    ['a@example.com.evil.org', 'example.com only as a prefix of the domain'],
    ['a@notexample.com', 'example.com only as a suffix of the domain'],
    ['a@sub.example.com', 'a subdomain'],
    ['a@example.comm', 'a longer top-level domain'],
    ['a@example.com ', 'a trailing blank'],
    ['a@example.com\nboss@company.com', 'a line break hiding a second address'],
    ['boss@company.com\na@example.com', 'a line break with the good address last'],
    ["a'@example.com", 'a single quote'],
    ["x' or '1'='1@example.com", 'SQL in the local part'],
    ["a@example.com' or email like '%", 'SQL after the address'],
    ['a@example.com,boss@company.com', 'two addresses in one argument'],
    ['a@example.com;drop table users', 'a statement after the address'],
    ['a\\@example.com', 'a backslash'],
    ['%@example.com', 'a LIKE wildcard'],
    ['boss', 'not an address'],
    ['example.com', 'only the domain'],
  ];
  for (const [address, why] of bad) {
    it(`${JSON.stringify(address)} - ${why}`, () => {
      assertRefused(run('delete-test-data.sh', [address]));
      assertRefused(run('delete-test-data.sh', ['--yes', address]));
    });
  }

  it('one good address does not excuse a bad one, in either order', () => {
    assertRefused(run('delete-test-data.sh', ['--yes', 'a@example.com', 'boss@company.com']));
    assertRefused(run('delete-test-data.sh', ['--yes', 'boss@company.com', 'a@example.com']));
    assertRefused(run('delete-test-data.sh', ['a@example.com', 'b@example.com', 'c@example.com', 'boss@company.com']));
  });

  it('refused without the dry-run switch too: nothing is read or deleted', () => {
    assertRefused(run('delete-test-data.sh', ['--yes', 'boss@company.com'], { dry: null }));
    assertRefused(run('delete-test-data.sh', ['boss@company.com'], { dry: null }));
  });

  it('refused on production with --production too', () => {
    assertRefused(run('delete-test-data.sh', ['--production', '--yes', 'boss@company.com'], { ref: PROD }));
    assertRefused(run('delete-test-data.sh', ['--production', 'boss@company.com'], { ref: PROD, dry: null }));
  });

  it('the refusal does not print the address back', () => {
    const result = run('delete-test-data.sh', ['--yes', 'boss@company.com']);
    assertRefused(result);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('boss@company.com'), show(result));
  });

  it('an unknown option is refused, not taken for an address or ignored', () => {
    for (const option of ['--force', '-y', '--all', '--yes=true', '--no-dry-run']) {
      assertRefused(run('delete-test-data.sh', [option]));
    }
  });

  it('@example.com addresses pass the check', () => {
    assertWouldRun(run('delete-test-data.sh', ['a@example.com']), STAGING);
    assertWouldRun(run('delete-test-data.sh', ['--yes', 'a@example.com', 'first.last+tag@example.com', 'crew_2-b@example.com']), STAGING);
    assertWouldRun(run('delete-test-data.sh', ['--yes']), STAGING);
  });
});

// ---------------------------------------------------------------------------
// create-user.sh: values that would break out of the SQL text
// ---------------------------------------------------------------------------

describe('create-user.sh refuses a quote, a backslash or a control character in any value (exit 2)', () => {
  const GOOD = ['a@example.com', 'a-strong-password', 'Driller', 'A Name', 'B-1'];
  const FIELDS = ['email', 'password', 'role', 'name', 'badge'];
  const poison = [
    ["'", 'a single quote'],
    ["x'); drop table auth.users; --", 'a quote that closes the SQL string'],
    ['\\', 'a backslash'],
    ["\\'", 'a backslash and a quote'],
    ['\n', 'a line feed'],
    ['\r', 'a carriage return'],
    ['\t', 'a tab'],
    ['\x01', 'a control character (0x01)'],
    ['\x1b[31m', 'an escape sequence'],
    ['\x7f', 'DEL'],
    ['\b', 'a backspace'],
  ];

  for (const [index, field] of FIELDS.entries()) {
    for (const [text, why] of poison) {
      for (const [placed, where] of [[`${GOOD[index]}${text}`, 'at the end'], [`${text}${GOOD[index]}`, 'at the start'], [`ab${text}cd`, 'in the middle']]) {
        it(`${field}: ${why}, ${where} (${JSON.stringify(placed)})`, () => {
          const args = [...GOOD];
          args[index] = placed;
          const result = run('create-user.sh', args);
          if (field === 'role') {
            // The role is also checked against a fixed list (exit 1). Either
            // refusal is fine; what matters is that the script stops.
            assert.ok(result.status === 1 || result.status === 2, show(result));
            assert.notEqual(result.stderr.trim(), '', show(result));
            assert.ok(!result.stdout.includes('would run against'), show(result));
          } else {
            assertRefused(result);
          }
        });
      }
    }
  }

  it('refused without the dry-run switch too: nothing is sent', () => {
    for (const index of [0, 1, 3, 4]) {
      const args = [...GOOD];
      args[index] = `${GOOD[index]}'`;
      assertRefused(run('create-user.sh', args, { dry: null }));
    }
  });

  it('refused on production with --production too', () => {
    assertRefused(run('create-user.sh', ['--production', 'a@example.com', 'pass\\word'], { ref: PROD }));
    assertRefused(run('create-user.sh', ['--production', "a'@example.com", 'a-strong-password'], { ref: PROD, dry: null }));
  });

  it('the default name (the part of the email before @) is checked as well', () => {
    assertRefused(run('create-user.sh', ["o'brien@example.com", 'a-strong-password']));
  });

  it('the refusal does not print the password back', () => {
    const result = run('create-user.sh', ['a@example.com', "s3cret-pass'word"]);
    assertRefused(result);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('s3cret-pass'), show(result));
  });

  it('ordinary values pass: every role, a name with a space, a badge', () => {
    for (const role of ['Driller', 'Data Logger', 'Supervisor', 'Administrator']) {
      assertWouldRun(run('create-user.sh', ['boss@example.com', 'a-strong-password', role, 'David Mutua', 'ADM-001']), STAGING);
    }
    assertWouldRun(run('create-user.sh', ['joe@example.com', 'P@ssw0rd!"#$%&()*+,-./:;<=>?[]^_{|}~']), STAGING);
  });

  it('a missing email or password stops before any network call', () => {
    for (const args of [[], ['a@example.com'], ['', 'a-strong-password'], ['a@example.com', '']]) {
      const result = run('create-user.sh', args);
      assert.notEqual(result.status, 0, show(result));
      assert.ok(!result.stdout.includes('would run against'), show(result));
      const live = run('create-user.sh', args, { dry: null });
      assert.notEqual(live.status, 0, show(live));
    }
  });

  it('a role outside the list stops before any network call', () => {
    for (const role of ['Admin', 'driller', 'Owner', 'Data  Logger', 'Driller ']) {
      const result = run('create-user.sh', ['a@example.com', 'a-strong-password', role], { dry: null });
      assert.notEqual(result.status, 0, show(result));
      assert.notEqual(result.stderr.trim(), '', show(result));
    }
  });
});

// ---------------------------------------------------------------------------
// check-attribution.sh: arguments
// ---------------------------------------------------------------------------

describe('check-attribution.sh accepts only [--production] [--fix]', () => {
  it('--fix passes', () => {
    assertWouldRun(run('check-attribution.sh', ['--fix']), STAGING);
  });
  for (const args of [['--yes'], ['extra'], ['--fix', '--fix'], ['--fix', 'extra'], ['--Fix'], ['--production', '--fix', 'extra'], ['--production', '--production']]) {
    it(`refused: ${JSON.stringify(args)}`, () => {
      assertRefused(run('check-attribution.sh', args));
      assertRefused(run('check-attribution.sh', args, { dry: null }));
    });
  }
});
