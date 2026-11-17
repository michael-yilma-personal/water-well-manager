// P0-7: the project's type check really checks JSX.
//
// Derived from "P0-7 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md:
//   - `@types/react` and `@types/react-dom` (major matching the installed
//     React) are dev dependencies, with the lockfile updated;
//   - a fixture component used with a wrong prop makes the same `tsc`
//     configuration fail with a type error, and the fixture with the right
//     prop passes. If the React types go missing again, this file fails.
//
// How: a throwaway directory under <repo>/node_modules/.cache/ (git-ignored;
// module resolution from there walks up into the repository's node_modules,
// so 'react' resolves exactly as it does for the application). It holds one
// fixture .tsx that imports a real component from src/ by absolute path, and
// a tsconfig that `extends` the repository's tsconfig.json and lists only the
// fixture (plus the repository's ambient declarations, src/vite-env.d.ts,
// which the real type check also sees). The repository's own TypeScript
// compiler is run on that tsconfig. Nothing is written into src/, and the
// directory is removed afterwards.
//
// The component is BottomNav (src/components/BottomNav.tsx). Its props:
//   activeTab: 'rig' | 'logs' | 'npt' | 'analytics'   required
//   onSelectTab: (tab) => void                         required
//   sunlightMode: boolean                              required
//   pipeCount?: number, nptCount?: number              optional
//
// Run: node --test "scripts/**/*.test.mjs"

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const COMPONENT = join(REPO, 'src', 'components', 'BottomNav');
const AMBIENT = join(REPO, 'src', 'vite-env.d.ts');

const TEMP_DIRS = [];
const cleanUp = () => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
};
after(cleanUp);
process.on('exit', cleanUp);

/**
 * Type-check one fixture with the repository's configuration.
 * Returns { status, out, file } where `file` is the fixture's file name.
 */
function typecheck(name, source) {
  const cache = join(REPO, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'typecheck-test-'));
  TEMP_DIRS.push(dir);
  const file = `${name}.tsx`;
  writeFileSync(join(dir, file), source);
  const files = [`./${file}`];
  if (existsSync(AMBIENT)) files.push(AMBIENT);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ extends: join(REPO, 'tsconfig.json'), compilerOptions: { noEmit: true }, files }, null, 2)}\n`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [TSC, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 240000,
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`, file, error: result.error };
}

const show = (result) => `exit ${result.status}${result.error ? ` (${result.error.message})` : ''}\n${result.out}`;

/** The error lines tsc printed for the fixture file: "<path>/<file>(line,col): error TSxxxx: message". */
function fixtureErrors(result) {
  return result.out
    .split('\n')
    .filter((line) => line.includes(result.file) && /\berror TS\d+:/.test(line));
}

const IMPORTS = `import { BottomNav } from ${JSON.stringify(COMPONENT)};\n`;

const RIGHT = `${IMPORTS}
export const required = <BottomNav activeTab="rig" onSelectTab={(tab) => { void tab; }} sunlightMode={false} />;
export const withOptional = <BottomNav activeTab="logs" onSelectTab={() => {}} sunlightMode pipeCount={3} nptCount={0} />;
export const intrinsic = <div className="x" onClick={() => {}} />;
`;

// One wrong usage per line, each on a line of its own so the error position names it.
const WRONG_PROP = `${IMPORTS}
export const wrong = <BottomNav activeTab="rig" onSelectTab={() => {}} sunlightMode={false} noSuchProp="x" />;
`;

const WRONG_VALUE = `${IMPORTS}
export const wrong = <BottomNav activeTab="rig" onSelectTab={() => {}} sunlightMode="yes" />;
`;

const WRONG_UNION = `${IMPORTS}
export const wrong = <BottomNav activeTab="settings" onSelectTab={() => {}} sunlightMode={false} />;
`;

const MISSING_REQUIRED = `${IMPORTS}
export const wrong = <BottomNav activeTab="rig" onSelectTab={() => {}} />;
`;

const WRONG_INTRINSIC = `
export const wrong = <div noSuchAttribute={1} />;
`;

const PLAIN_TS_ERROR = `
export const n: number = 'not a number';
`;

describe('P0-7: the type-check harness itself works', () => {
  before(() => {
    assert.ok(existsSync(TSC), `the TypeScript compiler is not installed at ${TSC}; run npm ci`);
  });

  it('the lint script is still the plain tsc run this test stands in for', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.lint, 'tsc --noEmit');
  });

  it('a fixture with an ordinary type error (no React involved) fails, and the error names the fixture', () => {
    const result = typecheck('plain-error', PLAIN_TS_ERROR);
    assert.notEqual(result.status, 0, `the fixture is not being checked at all:\n${show(result)}`);
    const errors = fixtureErrors(result);
    assert.ok(errors.some((line) => /error TS2322:/.test(line)), show(result));
  });

  it('the temporary directory is inside node_modules/.cache, not in src/', () => {
    const result = typecheck('location', 'export const ok = 1;\n');
    assert.equal(result.status, 0, show(result));
    for (const dir of TEMP_DIRS) {
      assert.ok(dir.startsWith(join(REPO, 'node_modules', '.cache')), dir);
    }
  });
});

describe('P0-7: a component used correctly passes the type check', () => {
  it('BottomNav with its required props, with its optional props, and a plain <div>: exit 0, no errors', () => {
    const result = typecheck('right-props', RIGHT);
    assert.equal(result.status, 0, show(result));
    assert.deepEqual(fixtureErrors(result), [], show(result));
  });
});

describe('P0-7: a component used wrongly fails the type check (red while React is untyped)', () => {
  const cases = [
    ['a prop that does not exist', 'wrong-prop', WRONG_PROP, /error TS2322:.*noSuchProp/],
    ['a string where a boolean prop is declared', 'wrong-value', WRONG_VALUE, /error TS2322:/],
    ['a value outside the declared union of tab names', 'wrong-union', WRONG_UNION, /error TS2322:/],
    ['a required prop left out', 'missing-required', MISSING_REQUIRED, /error TS2741:.*sunlightMode/],
    ['an attribute that no HTML element has, on a <div>', 'wrong-intrinsic', WRONG_INTRINSIC, /error TS2322:.*noSuchAttribute/],
  ];
  for (const [why, name, source, expected] of cases) {
    it(`${why}: non-zero exit and a type error in the fixture file`, () => {
      const result = typecheck(name, source);
      assert.notEqual(result.status, 0, `tsc accepted ${why}; JSX is not being type-checked (are the React types installed?)\n${show(result)}`);
      const errors = fixtureErrors(result);
      assert.ok(errors.length > 0, `tsc failed, but not with an error in ${result.file}:\n${show(result)}`);
      assert.ok(errors.some((line) => expected.test(line)), `expected ${expected} in:\n${errors.join('\n')}`);
      // The error is in the fixture, on the line of the wrong usage (line 3 with the import, line 2 without).
      assert.ok(errors.every((line) => /\((2|3),\d+\): error/.test(line)), `an error outside the wrong usage:\n${errors.join('\n')}`);
    });
  }
});

describe('P0-7: the React type packages are dev dependencies matching the installed React', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const major = (range) => {
    const match = /(\d+)/.exec(String(range ?? ''));
    return match ? Number(match[1]) : null;
  };

  for (const [types, runtime] of [['@types/react', 'react'], ['@types/react-dom', 'react-dom']]) {
    it(`${types} is in devDependencies with the same major version as ${runtime}`, () => {
      const range = pkg.devDependencies?.[types];
      assert.ok(range, `${types} is not in devDependencies`);
      assert.equal(pkg.dependencies?.[types], undefined, `${types} belongs in devDependencies only`);
      const want = major(pkg.dependencies?.[runtime] ?? pkg.devDependencies?.[runtime]);
      assert.notEqual(want, null, `${runtime} is not a dependency`);
      assert.equal(major(range), want, `${types} ${range} does not match ${runtime} major ${want}`);
    });

    it(`${types} is in the lockfile and installed, with the major version of the installed ${runtime}`, () => {
      const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
      const locked = lock.packages?.[`node_modules/${types}`];
      assert.ok(locked, `package-lock.json has no node_modules/${types}`);
      // Corrected (P0-7): this asserted `dev === true` only. npm marks a
      // package `devOptional` when it is a dev dependency of the project AND
      // an optional (peer) dependency of something in the production tree;
      // react-redux declares `@types/react` as an optional peer, so that is
      // how npm itself records it, and npm rewrites a hand edit. Either flag
      // means "not needed by a production install"; a package with neither
      // flag is a plain production dependency, which is what must not happen.
      assert.ok(
        locked.dev === true || locked.devOptional === true,
        `${types} is recorded as a plain production package in the lockfile (neither dev nor devOptional)`,
      );
      const rootEntry = lock.packages?.[''] ?? {};
      assert.ok(rootEntry.devDependencies?.[types], `the lockfile's root entry does not list ${types} under devDependencies`);
      assert.equal(rootEntry.dependencies?.[types], undefined, `the lockfile's root entry lists ${types} under dependencies`);
      const lockedRuntime = lock.packages?.[`node_modules/${runtime}`];
      assert.ok(lockedRuntime, `package-lock.json has no node_modules/${runtime}`);
      assert.equal(major(locked.version), major(lockedRuntime.version));
      const installed = join(REPO, 'node_modules', types, 'package.json');
      assert.ok(existsSync(installed), `${types} is not installed in node_modules; run npm ci`);
      assert.equal(JSON.parse(readFileSync(installed, 'utf8')).version, locked.version);
    });
  }
});
