// WF-4: the secret scan (scripts/check-secrets.sh).
//
// Derived from "WF-4 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md
// (Secret scan) and from RF-016 and RF-022 in docs/saas/REVIEW_FINDINGS.md.
//
// Every test builds a throwaway git repository under os.tmpdir() and points
// the script at it with CHECK_SECRETS_ROOT. Exit 0 = clean, 1 = something
// secret-shaped was found, any other non-zero status = the scan itself failed.
//
// Every secret-shaped string below is assembled at run time from harmless
// pieces, so this file contains nothing the scan would match, and every value
// is an obvious fixture, never a real credential.
//
// If the script ignores CHECK_SECRETS_ROOT it scans the real repository, which
// is clean, so every "not flagged" expectation would pass for the wrong
// reason. Each test therefore first requires that the root is honoured.
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
const SCRIPT = join(HERE, 'check-secrets.sh');

// ---------------------------------------------------------------------------
// Fixture values, built from pieces
// ---------------------------------------------------------------------------

const cat = (...pieces) => pieces.join('');
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const FILLER = 'FixtureValue';

/** A Supabase secret key shape. */
const SB_SECRET = cat('sb', '_', 'secret', '_', FILLER.repeat(2), '0123');
/** A Supabase publishable key shape: public by design, must stay allowed. */
const SB_PUBLISHABLE = cat('sb_publishable_', FILLER.repeat(2), '0123');
/** A Supabase management token shape. */
const SBP_TOKEN = cat('sb', 'p', '_', 'abcdef0123'.repeat(4));
/** A PEM private key header. */
const PEM_HEADER = cat('-----', 'BEGIN ', 'RSA ', 'PRIVATE ', 'KEY', '-----');

/** A three-segment token shaped like a JWT, exactly `length` characters, with fixture contents and no real signature. */
function fakeJwt(length) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ iss: 'fixture' });
  const signatureLength = length - cat(header, '.', payload, '.').length;
  assert.ok(signatureLength >= 8, 'fixture too short to hold three segments');
  return cat(header, '.', payload, '.', 'fixturesig'.repeat(20).slice(0, signatureLength));
}
const LONG_JWT = fakeJwt(160);
const JWT_OF_100 = fakeJwt(100);
/** Three base64url segments, but far shorter than any real token. */
const SHORT_DOTTED_TOKEN = cat(b64url({ a: 1 }), '.', b64url({ b: 2 }), '.', 'sig');

/** What a service-role key is assigned from in these fixtures: key-shaped but not a full JWT. */
const KEY_VALUE = cat('ey', 'J', FILLER.repeat(4));

const SR = cat('service', '_', 'role');
const SR_UPPER = SR.toUpperCase();
const SR_CAMEL = cat('service', 'Role', 'Key');

const AT = String.fromCharCode(64);
/** A Postgres URL; with a password it is secret-shaped. */
function pgUrl({ scheme = 'postgresql', user = 'postgres', password = '', host = 'db.example.test', port = '5432' } = {}) {
  const credentials = password ? [user, password].join(':') : user;
  return [scheme, cat('//', credentials, AT, host), cat(port, '/postgres')].join(':');
}
const PG_PASSWORD = cat('fixture', 'pw', '123');

const GH = (prefix, length) => cat(prefix, '_', FILLER.repeat(8).slice(0, length));
const GITHUB_TOKENS = [
  ['classic personal token', GH(cat('gh', 'p'), 36)],
  ['OAuth token', GH(cat('gh', 'o'), 36)],
  ['server token', GH(cat('gh', 's'), 36)],
  ['fine-grained personal token', cat('github', '_', 'pat', '_', FILLER.repeat(2).slice(0, 22), '_', FILLER.repeat(5).slice(0, 59))],
];

const STORE_PW = cat('store', 'Password');
const KEY_PW = cat('key', 'Password');
const GRADLE_VALUE = cat('fixture', 'Gradle', 'Value1');

// ---------------------------------------------------------------------------
// Throwaway repositories
// ---------------------------------------------------------------------------

const TEMP_DIRS = [];
after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const GIT_ENV = (() => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  delete env.CHECK_SECRETS_ROOT;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Secrets Test',
    GIT_AUTHOR_EMAIL: 'secrets-test@example.com',
    GIT_COMMITTER_NAME: 'Secrets Test',
    GIT_COMMITTER_EMAIL: 'secrets-test@example.com',
    // A directory that is not a repository must not find one further up.
    GIT_CEILING_DIRECTORIES: dirname(tmpdir()),
  };
})();

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

function write(repo, path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** A repository with the given files committed. */
function makeRepo(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'check-secrets-test-'));
  TEMP_DIRS.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'README.md', '# Fixture repository\n\nNothing secret here.\n');
  write(repo, '.gitignore', 'ignored/\n');
  for (const [path, content] of Object.entries(files)) write(repo, path, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Fixture');
  return repo;
}

function scan(root) {
  const result = spawnSync(SCRIPT, [], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...GIT_ENV, CHECK_SECRETS_ROOT: root },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Lines 1-2 and 4-5 are ordinary; the line under test is line 3. */
const onLineThree = (line) => `# settings\nname = fixture\n${line}\nmode = test\n# end\n`;

let rootHonoured;
/** Fail the calling test unless the script scans CHECK_SECRETS_ROOT. */
function requireRoot() {
  if (rootHonoured === undefined) {
    const repo = makeRepo({ 'probe.txt': `${SB_SECRET}\n` });
    rootHonoured = scan(repo).status === 1;
  }
  assert.ok(
    rootHonoured,
    'check-secrets.sh does not honour CHECK_SECRETS_ROOT: a secret key shape in the temporary repository was not found',
  );
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The output names the file and, right after it, the line number. */
function assertNamesFileAndLine(out, file, line) {
  const pattern = new RegExp(`${escapeRegExp(file)}[^0-9\\n]{1,12}${line}(?![0-9])`);
  assert.match(out, pattern, `expected the output to give ${file} and line ${line}:\n${out}`);
}

/** Scan a repository holding `line` on line 3 of `file`; expect it to be caught without being printed. */
function expectCaught(line, { file = 'config/settings.txt', secrets = [] } = {}) {
  requireRoot();
  const repo = makeRepo({ [file]: onLineThree(line) });
  const result = scan(repo);
  assert.equal(result.status, 1, `expected exit 1 (found), got exit ${result.status}:\n${result.out}`);
  assertNamesFileAndLine(result.out, file, 3);
  for (const secret of [line, ...secrets]) {
    assert.ok(!result.out.includes(secret), 'the output must never contain the matched text');
  }
}

/** Scan a repository holding `line` on line 3 of `file`; expect a clean result. */
function expectClean(line, { file = 'config/settings.txt' } = {}) {
  requireRoot();
  const repo = makeRepo({ [file]: onLineThree(line) });
  const result = scan(repo);
  assert.equal(result.status, 0, `expected exit 0 (clean), got exit ${result.status}:\n${result.out}`);
}

// ---------------------------------------------------------------------------
// CHECK_SECRETS_ROOT
// ---------------------------------------------------------------------------

describe('CHECK_SECRETS_ROOT points the script at another repository', () => {
  it('a secret key shape in the temporary repository is found', () => {
    requireRoot();
  });

  it('a clean temporary repository passes', () => {
    requireRoot();
    assert.equal(scan(makeRepo()).status, 0);
  });
});

// ---------------------------------------------------------------------------
// What was already caught, and must still be
// ---------------------------------------------------------------------------

describe('shapes the scan already knew', () => {
  it('a Supabase secret key', () => {
    expectCaught(`SUPABASE_KEY=${SB_SECRET}`, { secrets: [SB_SECRET] });
  });

  it('a Supabase management token', () => {
    expectCaught(`token: ${SBP_TOKEN}`, { secrets: [SBP_TOKEN] });
  });

  it('a Supabase management token on its own, in a shell export', () => {
    expectCaught(`export SUPABASE_ACCESS_TOKEN=${SBP_TOKEN}`, { secrets: [SBP_TOKEN], file: 'scripts/env.sh' });
  });

  it('a PEM private key header', () => {
    expectCaught(PEM_HEADER, { file: 'keys/deploy.pem' });
  });
});

// ---------------------------------------------------------------------------
// Service-role key assignments (RF-016)
// ---------------------------------------------------------------------------

describe('a service-role key assigned in any common form is caught', () => {
  const forms = [
    ['.env form', `SUPABASE_${SR_UPPER}_KEY=${KEY_VALUE}`],
    ['.env form with double quotes', `SUPABASE_${SR_UPPER}_KEY="${KEY_VALUE}"`],
    ['.env form with single quotes', `SUPABASE_${SR_UPPER}_KEY='${KEY_VALUE}'`],
    ['shell export', `export SUPABASE_${SR_UPPER}_KEY=${KEY_VALUE}`],
    ['spaces around the equals sign', `${SR_UPPER}_KEY = "${KEY_VALUE}"`],
    ['Vite-prefixed variable', `VITE_SUPABASE_${SR_UPPER}_KEY=${KEY_VALUE}`],
    ['lower case', `supabase_${SR}_key=${KEY_VALUE}`],
    ['mixed case', cat('Supabase_', 'Service', '_', 'Role', '_Key', '=', KEY_VALUE)],
    ['JSON property', `  "${SR}_key": "${KEY_VALUE}",`],
    ['YAML property', `${SR}: ${KEY_VALUE}`],
    ['YAML property with quotes', `${SR}_key: '${KEY_VALUE}'`],
    ['JavaScript object property', `  ${SR}: '${KEY_VALUE}',`],
    ['JavaScript constant', `const ${SR_UPPER}_KEY = '${KEY_VALUE}';`],
    ['assigned a full JWT', `SUPABASE_${SR_UPPER}_KEY=${LONG_JWT}`],
  ];
  for (const [name, line] of forms) {
    it(name, () => {
      expectCaught(line, { secrets: [KEY_VALUE, LONG_JWT], file: 'config/app.env.example' });
    });
  }
});

describe('a service-role key (assumed reading): camel-case names are a common form too', () => {
  it('JavaScript constant in camel case', () => {
    expectCaught(`const ${SR_CAMEL} = '${KEY_VALUE}';`, { secrets: [KEY_VALUE], file: 'src/admin/client.ts' });
  });

  it('camel-case object property', () => {
    expectCaught(`  ${SR_CAMEL}: "${KEY_VALUE}",`, { secrets: [KEY_VALUE], file: 'src/admin/client.ts' });
  });
});

// ---------------------------------------------------------------------------
// Bare JWTs (RF-016)
// ---------------------------------------------------------------------------

describe('a bare JWT of three base64url segments, at least 100 characters long, is caught', () => {
  it('on a line of its own', () => {
    expectCaught(LONG_JWT);
  });

  it('assigned to an unrelated name', () => {
    expectCaught(`const anon = "${LONG_JWT}";`, { secrets: [LONG_JWT], file: 'src/config.ts' });
  });

  it('in an Authorization header', () => {
    expectCaught(`curl -H "Authorization: Bearer ${LONG_JWT}" http://localhost/`, { secrets: [LONG_JWT], file: 'docs/howto.md' });
  });

  it('as a JSON value', () => {
    expectCaught(`  "apikey": "${LONG_JWT}"`, { secrets: [LONG_JWT], file: 'fixtures/request.json' });
  });

  it('exactly 100 characters long', () => {
    assert.equal(JWT_OF_100.length, 100);
    expectCaught(JWT_OF_100);
  });
});

// ---------------------------------------------------------------------------
// Postgres URLs with an inline password (RF-016)
// ---------------------------------------------------------------------------

describe('a Postgres URL with an inline password is caught', () => {
  const urls = [
    ['postgresql:// scheme', pgUrl({ password: PG_PASSWORD })],
    ['postgres:// scheme', pgUrl({ scheme: 'postgres', password: PG_PASSWORD })],
    ['upper-case scheme', pgUrl({ scheme: 'POSTGRESQL', password: PG_PASSWORD })],
    ['pooler user with a dot', pgUrl({ user: 'postgres.fixtureproject', password: PG_PASSWORD, host: 'pooler.example.test', port: '6543' })],
  ];
  for (const [name, url] of urls) {
    it(`${name}, in an env file`, () => {
      expectCaught(`DATABASE_URL=${url}`, { secrets: [url, PG_PASSWORD], file: 'config/db.env.example' });
    });
  }

  it('quoted, in a script', () => {
    const url = pgUrl({ password: PG_PASSWORD });
    expectCaught(`psql "${url}" -c "select 1"`, { secrets: [url, PG_PASSWORD], file: 'scripts/query.sh' });
  });
});

// ---------------------------------------------------------------------------
// GitHub tokens (RF-016)
// ---------------------------------------------------------------------------

describe('GitHub tokens are caught', () => {
  for (const [name, token] of GITHUB_TOKENS) {
    it(`${name}, assigned`, () => {
      expectCaught(`GITHUB_TOKEN=${token}`, { secrets: [token], file: 'ci/settings.env.example' });
    });
    it(`${name}, inside a remote URL`, () => {
      const line = ['https', cat('//x-access-token:', token, AT, 'github.com/owner/repo.git')].join(':');
      expectCaught(line, { secrets: [token], file: 'docs/deploy.md' });
    });
  }
});

// ---------------------------------------------------------------------------
// Gradle signing passwords (RF-016)
// ---------------------------------------------------------------------------

describe('Gradle signing passwords are caught in =, quoted and space-separated forms', () => {
  for (const keyword of [STORE_PW, KEY_PW]) {
    const forms = [
      ['properties form, name=value', `${keyword}=${GRADLE_VALUE}`, 'android/keystore-copy.properties'],
      ['Kotlin DSL, name = "value"', `    ${keyword} = "${GRADLE_VALUE}"`, 'android/app/build.gradle.kts'],
      ['Groovy DSL, name "value"', `    ${keyword} "${GRADLE_VALUE}"`, 'android/app/build.gradle'],
      ["Groovy DSL, name 'value'", `    ${keyword} '${GRADLE_VALUE}'`, 'android/app/build.gradle'],
      ["name = 'value'", `${keyword} = '${GRADLE_VALUE}'`, 'android/app/build.gradle'],
    ];
    for (const [name, line, file] of forms) {
      it(`${keyword.replace('Password', ' password')}: ${name}`, () => {
        expectCaught(line, { secrets: [GRADLE_VALUE], file });
      });
    }
  }

  it('upper-case property name', () => {
    expectCaught(`${STORE_PW.toUpperCase()}=${GRADLE_VALUE}`, { secrets: [GRADLE_VALUE], file: 'android/signing.properties' });
  });
});

// ---------------------------------------------------------------------------
// What must not be flagged
// ---------------------------------------------------------------------------

describe('publishable keys and ordinary text are not flagged', () => {
  const clean = [
    ['a publishable key', `VITE_SUPABASE_KEY=${SB_PUBLISHABLE}`],
    ['a publishable key in source', `const supabaseKey = '${SB_PUBLISHABLE}';`],
    ['the service role named in SQL', `grant usage on schema public to ${SR};`],
    ['the service role named in a policy', `create policy p on t for all to ${SR} using (true);`],
    ['a service-role variable read from the environment', `const key = process.env.SUPABASE_${SR_UPPER}_KEY;`],
    ['a service-role variable with no value', `SUPABASE_${SR_UPPER}_KEY=`],
    ['a service-role variable mentioned in a comment', `# set SUPABASE_${SR_UPPER}_KEY in the dashboard, never in the repository`],
    ['a Postgres URL without a password', `DATABASE_URL=${pgUrl({ host: 'localhost', port: '54322' })}`],
    ['a version number', 'version 1.2.3 released'],
    ['a host name', 'see www.example.com for details'],
    ['a short dotted word of three parts', 'abc.def.ghi'],
    ['a Java class name', 'com.example.waterwell.MainActivity'],
    ['a dotted import path', "import { sync } from './services/sync.service.js';"],
    ['a long hash with no dots', `integrity ${'a3f9'.repeat(16)}`],
    ['three short base64url segments', `token ${SHORT_DOTTED_TOKEN}`],
    ['a GitHub word that is not a token', 'ghp is not a prefix here, and gho_st is a word'],
    ['a Gradle password read from a properties object', `    ${STORE_PW} keystoreProperties['${STORE_PW}']`],
    ['a Gradle key password read from a properties object', `    ${KEY_PW} keystoreProperties['${KEY_PW}']`],
    ['a Gradle password read from the environment', `    ${STORE_PW} System.getenv("ANDROID_STORE_PW")`],
    ['prose about passwords', 'The store and key passwords live in the keystore properties file.'],
    ['a mention of private keys in prose', 'Never commit a private key.'],
  ];
  for (const [name, line] of clean) {
    it(name, () => {
      expectClean(line);
    });
  }
});

// ---------------------------------------------------------------------------
// Output: file and line number, never the secret (RF-022)
// ---------------------------------------------------------------------------

describe('the output gives file and line number and never the matched text', () => {
  it('reports the right line when the secret is on line 1', () => {
    requireRoot();
    const repo = makeRepo({ 'a.env.example': `KEY=${SB_SECRET}\nother=1\n` });
    const result = scan(repo);
    assert.equal(result.status, 1);
    assertNamesFileAndLine(result.out, 'a.env.example', 1);
    assert.ok(!result.out.includes(SB_SECRET));
  });

  it('reports the right line deep in a file', () => {
    requireRoot();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    lines[26] = `token = ${LONG_JWT}`;
    const repo = makeRepo({ 'docs/long.md': `${lines.join('\n')}\n` });
    const result = scan(repo);
    assert.equal(result.status, 1);
    assertNamesFileAndLine(result.out, 'docs/long.md', 27);
    assert.ok(!result.out.includes(LONG_JWT));
  });

  it('reports every file that holds a secret', () => {
    requireRoot();
    const repo = makeRepo({
      'one.txt': onLineThree(`a=${SB_SECRET}`),
      'two/three.txt': `x\n${GITHUB_TOKENS[0][1]}\n`,
      'clean.txt': 'nothing\n',
    });
    const result = scan(repo);
    assert.equal(result.status, 1);
    assertNamesFileAndLine(result.out, 'one.txt', 3);
    assertNamesFileAndLine(result.out, 'two/three.txt', 2);
    assert.ok(!result.out.includes('clean.txt'), 'a clean file is not listed');
    assert.ok(!result.out.includes(SB_SECRET));
    assert.ok(!result.out.includes(GITHUB_TOKENS[0][1]));
  });

  it('reports both lines when one file holds two secrets', () => {
    requireRoot();
    const repo = makeRepo({ 'two.txt': `a=${SB_SECRET}\nplain\nb=${SBP_TOKEN}\n` });
    const result = scan(repo);
    assert.equal(result.status, 1);
    assertNamesFileAndLine(result.out, 'two.txt', 1);
    assertNamesFileAndLine(result.out, 'two.txt', 3);
  });

  it('does not print the rest of the line either', () => {
    requireRoot();
    const marker = 'REST-OF-THE-LINE-MARKER';
    const repo = makeRepo({ 'a.txt': `${marker} ${SB_SECRET} ${marker}\n` });
    const result = scan(repo);
    assert.equal(result.status, 1);
    assert.ok(!result.out.includes(marker), `the matched line was printed:\n${result.out.replace(SB_SECRET, '<fixture>')}`);
  });

  it('does not print the password of a Postgres URL', () => {
    requireRoot();
    const repo = makeRepo({ 'db.txt': `${pgUrl({ password: PG_PASSWORD })}\n` });
    const result = scan(repo);
    assert.equal(result.status, 1);
    assert.ok(!result.out.includes(PG_PASSWORD));
  });
});

// ---------------------------------------------------------------------------
// Which files are scanned
// ---------------------------------------------------------------------------

describe('which files are scanned', () => {
  it('an untracked file that is not ignored is scanned', () => {
    requireRoot();
    const repo = makeRepo();
    write(repo, 'new-notes.txt', `x\n${SB_SECRET}\n`);
    const result = scan(repo);
    assert.equal(result.status, 1);
    assertNamesFileAndLine(result.out, 'new-notes.txt', 2);
  });

  it('a file whose name contains a space is scanned', () => {
    requireRoot();
    const repo = makeRepo({ 'docs/my notes.txt': `${SB_SECRET}\n` });
    const result = scan(repo);
    assert.equal(result.status, 1);
    assertNamesFileAndLine(result.out, 'docs/my notes.txt', 1);
  });

  it('a staged but uncommitted file is scanned', () => {
    requireRoot();
    const repo = makeRepo();
    write(repo, 'staged.txt', `${GITHUB_TOKENS[0][1]}\n`);
    git(repo, 'add', 'staged.txt');
    const result = scan(repo);
    assert.equal(result.status, 1);
    assertNamesFileAndLine(result.out, 'staged.txt', 1);
  });
});

// ---------------------------------------------------------------------------
// A failure of the scan itself (RF-016)
// ---------------------------------------------------------------------------

describe('a failure of the scan itself exits non-zero', () => {
  it('the root directory does not exist', () => {
    const missing = join(tmpdir(), `check-secrets-test-missing-${process.pid}`);
    const result = scan(missing);
    assert.notEqual(result.status, 0, `a scan that could not run reported success:\n${result.out}`);
  });

  it('the root is not a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'check-secrets-test-norepo-'));
    TEMP_DIRS.push(plain);
    writeFileSync(join(plain, 'file.txt'), 'nothing\n');
    const result = scan(plain);
    assert.notEqual(result.status, 0, `a scan that could not list files reported success:\n${result.out}`);
  });

  it('a tracked file cannot be read', (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root can read any file, so this cannot be simulated');
      return;
    }
    const repo = makeRepo({ 'locked.txt': 'nothing secret, but unreadable\n' });
    chmodSync(join(repo, 'locked.txt'), 0o000);
    try {
      const result = scan(repo);
      assert.notEqual(result.status, 0, `a scan that could not read a file reported success:\n${result.out}`);
    } finally {
      chmodSync(join(repo, 'locked.txt'), 0o600);
    }
  });
});

// ===========================================================================
// WF-4 validation (after implementation)
//
// Behaviour found by reading the implementation and trying to break it. The
// first block pins what works; the blocks after it are weaknesses and are red
// until the script is changed (or the Lead rules the behaviour acceptable).
// ===========================================================================

describe('validation: what the scan gets right beyond the first tests', () => {
  it('a long token after two short dotted tokens on the same line is caught', () => {
    expectCaught(`a=${SHORT_DOTTED_TOKEN} b=${SHORT_DOTTED_TOKEN} c=${LONG_JWT}`, { secrets: [LONG_JWT] });
  });

  it('a token on a line with Windows line endings is caught', () => {
    requireRoot();
    const repo = makeRepo({ 'config/windows.txt': `first\r\nsecond\r\n${LONG_JWT}\r\n` });
    const result = scan(repo);
    assert.equal(result.status, 1, result.out);
    assertNamesFileAndLine(result.out, 'config/windows.txt', 3);
    assert.ok(!result.out.includes(LONG_JWT));
  });

  it('a token in a file whose name contains a tab is still reported, without its text', () => {
    requireRoot();
    const repo = makeRepo({ 'odd\tname.txt': `${LONG_JWT}\n` });
    const result = scan(repo);
    assert.equal(result.status, 1, result.out);
    assert.ok(!result.out.includes(LONG_JWT));
  });

  it('a secret in the second of two files is caught when the first file is clean', () => {
    requireRoot();
    const repo = makeRepo({ 'a-first.txt': 'nothing\n', 'z-last.txt': `${SBP_TOKEN}\n` });
    const result = scan(repo);
    assert.equal(result.status, 1, result.out);
    assertNamesFileAndLine(result.out, 'z-last.txt', 1);
  });

  it('a clean repository says so and exits 0', () => {
    requireRoot();
    const result = scan(makeRepo({ 'notes.txt': 'nothing secret\n' }));
    assert.equal(result.status, 0, result.out);
  });
});

describe('validation: a file name that looks like a grep option does not silence the scan', () => {
  // File names are handed to grep as plain arguments. A tracked file called
  // "-q" (or "--include=...") is read by grep as an option, grep prints
  // nothing, and the scan reports a clean repository without having looked.
  for (const name of ['-q', '--include=nothing-matches-this', '-s']) {
    it(`a tracked file named ${name} next to a file holding a secret key`, () => {
      requireRoot();
      const repo = makeRepo({ [name]: 'an ordinary file\n', 'config/settings.txt': onLineThree(SB_SECRET) });
      const result = scan(repo);
      assert.notEqual(result.status, 0, `the scan reported a clean repository:\n${result.out}`);
      assert.ok(!result.out.includes(SB_SECRET), 'the output must never contain the matched text');
    });
  }
});

describe('validation: what is staged is scanned, not only what is on disk', () => {
  // The scan reads the working tree. A secret that was staged and then edited
  // out of (or deleted from) the working copy is still in the index and goes
  // into the next commit.
  it('a secret staged, then edited out of the working copy', () => {
    requireRoot();
    const repo = makeRepo();
    write(repo, 'config/local.txt', `${SB_SECRET}\n`);
    git(repo, 'add', 'config/local.txt');
    write(repo, 'config/local.txt', 'cleaned up\n');
    const result = scan(repo);
    assert.notEqual(result.status, 0, `the staged secret would be committed, and the scan said:\n${result.out}`);
  });

  it('a secret staged, then the file deleted from the working copy', () => {
    requireRoot();
    const repo = makeRepo();
    write(repo, 'config/local.txt', `${SB_SECRET}\n`);
    git(repo, 'add', 'config/local.txt');
    rmSync(join(repo, 'config/local.txt'));
    const result = scan(repo);
    assert.notEqual(result.status, 0, `the staged secret would be committed, and the scan said:\n${result.out}`);
  });
});

describe('validation: Gradle signing passwords in the forms a properties file allows', () => {
  // The criteria say "=, quoted and space-separated forms". A .properties
  // file accepts "name = value", "name: value" and "name value".
  for (const keyword of [STORE_PW, KEY_PW]) {
    const forms = [
      ['name = value (blanks around the equals sign)', `${keyword} = ${GRADLE_VALUE}`],
      ['name: value', `${keyword}: ${GRADLE_VALUE}`],
      ['name value (space-separated, unquoted)', `${keyword} ${GRADLE_VALUE}`],
    ];
    for (const [name, line] of forms) {
      it(`${keyword.replace('Password', ' password')}: ${name}`, () => {
        expectCaught(line, { secrets: [GRADLE_VALUE], file: 'android/signing.properties' });
      });
    }
  }
});

describe('validation: signing passwords in neighbouring forms', () => {
  it('Groovy call form, name("value")', () => {
    expectCaught(`            ${STORE_PW}("${GRADLE_VALUE}")`, { secrets: [GRADLE_VALUE], file: 'android/app/build.gradle' });
  });

  it('a prefixed property, release.<name>=value', () => {
    expectCaught(`release.${STORE_PW}=${GRADLE_VALUE}`, { secrets: [GRADLE_VALUE], file: 'android/gradle.properties' });
  });

  it('JSON, "<name>": "value"', () => {
    expectCaught(`  "${STORE_PW}": "${GRADLE_VALUE}",`, { secrets: [GRADLE_VALUE], file: 'signing.json' });
  });

  it('Capacitor build options: keystorePassword in capacitor.config.json', () => {
    const name = cat('key', STORE_PW.toLowerCase().replace('password', 'Password'));
    expectCaught(`      "${name}": "${GRADLE_VALUE}",`, { secrets: [GRADLE_VALUE], file: 'capacitor.config.json' });
  });
});

describe('validation: Postgres URLs with a driver suffix or no user', () => {
  it('SQLAlchemy form, postgresql+psycopg2://user:password@host', () => {
    expectCaught(`DATABASE_URL=${pgUrl({ scheme: cat('postgresql', '+', 'psycopg2'), password: PG_PASSWORD })}`, { secrets: [PG_PASSWORD] });
  });

  it('a password with an empty user, postgresql://:password@host', () => {
    expectCaught(`DATABASE_URL=${pgUrl({ user: '', password: PG_PASSWORD })}`, { secrets: [PG_PASSWORD] });
  });
});
