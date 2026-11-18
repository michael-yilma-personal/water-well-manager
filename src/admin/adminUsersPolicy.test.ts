// P1-7, criteria 32, 34, 35 and 37: the decisions of the `admin-users` edge
// function, as pure functions in supabase/functions/admin-users/policy.ts.
//
//   32  the caller needs an ACTIVE membership with the role Administrator in
//       the FOUNDING organization; with no founding organization nobody passes
//   34  a target needs a membership in the founding organization; any other
//       id, existing or not, is "not found", and the two are indistinguishable
//   35  a target that also has a membership in another organization is
//       refused: a ban or a deletion acts on the whole account
//   37  the module has no imports and uses neither Deno nor the network, and
//       index.ts decides with it
//
// Written before the module exists. What the deployed function does with
// these answers (401, 403, 404, 409, and that nothing is changed) is proved on
// staging in the tenant-isolation suite (P1-3), not here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  callerMayAdminister,
  targetDecision,
} from '../../supabase/functions/admin-users/policy';
import type { Membership } from '../../supabase/functions/admin-users/policy';

const FOUNDING = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

const m = (orgId: string, role: string, status: string): Membership => ({ orgId, role, status });

const STATUSES = ['invited', 'active', 'deactivated'];
const ROLES = ['Driller', 'Data Logger', 'Supervisor', 'Administrator'];

// ---------------------------------------------------------------------------
// Criterion 32: who may call the function
// ---------------------------------------------------------------------------

test('an active Administrator of the founding organization may administer', () => {
  assert.equal(callerMayAdminister(FOUNDING, [m(FOUNDING, 'Administrator', 'active')]), true);
});

test('an active founding Administrator may administer whatever else they belong to, in any order', () => {
  const founding = m(FOUNDING, 'Administrator', 'active');
  assert.equal(callerMayAdminister(FOUNDING, [founding, m(OTHER, 'Driller', 'active')]), true);
  assert.equal(callerMayAdminister(FOUNDING, [m(OTHER, 'Driller', 'deactivated'), m(THIRD, 'Supervisor', 'invited'), founding]), true);
});

test('with no founding organization nobody may administer', () => {
  assert.equal(callerMayAdminister(null, []), false);
  assert.equal(callerMayAdminister(null, [m(FOUNDING, 'Administrator', 'active')]), false);
  assert.equal(callerMayAdminister(null, [m(OTHER, 'Administrator', 'active'), m(THIRD, 'Administrator', 'active')]), false);
});

test('with no founding organization, a membership row that carries no organization id does not match it', () => {
  // What a badly mapped row looks like at run time (org_id read as orgId):
  // "no founding organization" must not be equal to "no organization id".
  const blank = { orgId: null, role: 'Administrator', status: 'active' } as unknown as Membership;
  const missing = { role: 'Administrator', status: 'active' } as unknown as Membership;
  assert.equal(callerMayAdminister(null, [blank]), false);
  assert.equal(callerMayAdminister(null, [missing]), false);
  assert.equal(targetDecision(null, [blank]), 'not-found');
  assert.equal(targetDecision(null, [missing]), 'not-found');
});

test('a caller with no membership at all may not administer', () => {
  assert.equal(callerMayAdminister(FOUNDING, []), false);
});

test('a deactivated founding Administrator may not administer', () => {
  assert.equal(callerMayAdminister(FOUNDING, [m(FOUNDING, 'Administrator', 'deactivated')]), false);
});

test('an invited founding Administrator may not administer', () => {
  assert.equal(callerMayAdminister(FOUNDING, [m(FOUNDING, 'Administrator', 'invited')]), false);
});

test('a founding Administrator whose status is anything but "active" may not administer', () => {
  for (const status of ['', 'suspended', 'banned', 'pending']) {
    assert.equal(callerMayAdminister(FOUNDING, [m(FOUNDING, 'Administrator', status)]), false, `status ${JSON.stringify(status)}`);
  }
});

test('the Administrator of another organization only may not administer', () => {
  assert.equal(callerMayAdminister(FOUNDING, [m(OTHER, 'Administrator', 'active')]), false);
  assert.equal(callerMayAdminister(FOUNDING, [m(OTHER, 'Administrator', 'active'), m(THIRD, 'Administrator', 'active')]), false);
});

test('a Supervisor, Data Logger or Driller of the founding organization may not administer', () => {
  for (const role of ['Supervisor', 'Data Logger', 'Driller']) {
    assert.equal(callerMayAdminister(FOUNDING, [m(FOUNDING, role, 'active')]), false, role);
  }
});

test('a role that is not spelled exactly "Administrator" does not administer', () => {
  for (const role of ['admin', 'administrator', 'ADMINISTRATOR', 'Admin', ' Administrator', 'Administrator ', 'Administrators', '']) {
    assert.equal(callerMayAdminister(FOUNDING, [m(FOUNDING, role, 'active')]), false, `role ${JSON.stringify(role)}`);
  }
});

test('the role in one organization and the status in another do not add up', () => {
  // Supervisor here, Administrator there.
  assert.equal(
    callerMayAdminister(FOUNDING, [m(FOUNDING, 'Supervisor', 'active'), m(OTHER, 'Administrator', 'active')]),
    false,
  );
  // Administrator here but deactivated, active Administrator there.
  assert.equal(
    callerMayAdminister(FOUNDING, [m(FOUNDING, 'Administrator', 'deactivated'), m(OTHER, 'Administrator', 'active')]),
    false,
  );
  // Administrator here but only invited, active Driller there.
  assert.equal(
    callerMayAdminister(FOUNDING, [m(OTHER, 'Driller', 'active'), m(FOUNDING, 'Administrator', 'invited')]),
    false,
  );
});

test('which organization is the founding one is what was passed in, not a property of the memberships', () => {
  const memberships = [m(FOUNDING, 'Administrator', 'active'), m(OTHER, 'Driller', 'active')];
  assert.equal(callerMayAdminister(FOUNDING, memberships), true);
  assert.equal(callerMayAdminister(OTHER, memberships), false);
  assert.equal(callerMayAdminister(THIRD, memberships), false);
});

// ---------------------------------------------------------------------------
// Criteria 34 and 35: which accounts the function may act on
// ---------------------------------------------------------------------------

test('a target with one membership, in the founding organization, is ok whatever its role', () => {
  for (const role of ROLES) {
    assert.equal(targetDecision(FOUNDING, [m(FOUNDING, role, 'active')]), 'ok', role);
  }
});

test('a target whose founding membership is deactivated is still ok: it must be possible to reactivate it', () => {
  assert.equal(targetDecision(FOUNDING, [m(FOUNDING, 'Driller', 'deactivated')]), 'ok');
  assert.equal(targetDecision(FOUNDING, [m(FOUNDING, 'Administrator', 'deactivated')]), 'ok');
});

test('a target whose founding membership is still invited is ok: the membership exists, whatever its status', () => {
  assert.equal(targetDecision(FOUNDING, [m(FOUNDING, 'Supervisor', 'invited')]), 'ok');
});

test('a target with no memberships is not found', () => {
  assert.equal(targetDecision(FOUNDING, []), 'not-found');
});

test('a target in another organization only is not found, whatever its role and status there', () => {
  for (const status of STATUSES) {
    for (const role of ROLES) {
      assert.equal(targetDecision(FOUNDING, [m(OTHER, role, status)]), 'not-found', `${role}, ${status}`);
    }
  }
});

test('a target in two other organizations and not in the founding one is not found, not "other-organization"', () => {
  // Criterion 34: without a founding membership the answer must not say
  // anything about the account, not even that it exists somewhere else.
  assert.equal(targetDecision(FOUNDING, [m(OTHER, 'Driller', 'active'), m(THIRD, 'Administrator', 'active')]), 'not-found');
});

test('an account of another organization and an id that does not exist get the very same answer', () => {
  const missing = targetDecision(FOUNDING, []);
  assert.equal(targetDecision(FOUNDING, [m(OTHER, 'Administrator', 'active')]), missing);
  assert.equal(targetDecision(FOUNDING, [m(OTHER, 'Driller', 'deactivated')]), missing);
  assert.equal(targetDecision(FOUNDING, [m(OTHER, 'Driller', 'active'), m(THIRD, 'Driller', 'active')]), missing);
});

test('a target in the founding organization and in another one is refused as "other-organization", whatever the statuses and the order', () => {
  for (const here of STATUSES) {
    for (const there of STATUSES) {
      const founding = m(FOUNDING, 'Driller', here);
      const other = m(OTHER, 'Supervisor', there);
      assert.equal(targetDecision(FOUNDING, [founding, other]), 'other-organization', `founding ${here}, other ${there}`);
      assert.equal(targetDecision(FOUNDING, [other, founding]), 'other-organization', `other ${there}, founding ${here}`);
    }
  }
});

test('a target in the founding organization and in two others is refused as "other-organization"', () => {
  assert.equal(
    targetDecision(FOUNDING, [m(OTHER, 'Driller', 'deactivated'), m(FOUNDING, 'Administrator', 'active'), m(THIRD, 'Driller', 'invited')]),
    'other-organization',
  );
});

test('with no founding organization no target is ok', () => {
  assert.equal(targetDecision(null, []), 'not-found');
  assert.equal(targetDecision(null, [m(FOUNDING, 'Driller', 'active')]), 'not-found');
  assert.equal(targetDecision(null, [m(FOUNDING, 'Driller', 'active'), m(OTHER, 'Driller', 'active')]), 'not-found');
});

test('the target decision follows the founding organization that was passed in', () => {
  const memberships = [m(OTHER, 'Driller', 'active')];
  assert.equal(targetDecision(OTHER, memberships), 'ok');
  assert.equal(targetDecision(FOUNDING, memberships), 'not-found');
});

test('neither decision changes the memberships it is given', () => {
  const memberships = [m(OTHER, 'Driller', 'active'), m(FOUNDING, 'Administrator', 'active')];
  const copy = structuredClone(memberships);
  callerMayAdminister(FOUNDING, memberships);
  targetDecision(FOUNDING, memberships);
  assert.deepEqual(memberships, copy);
});

// ---------------------------------------------------------------------------
// Criterion 37: the module is pure, and the function decides with it
// ---------------------------------------------------------------------------

const FUNCTION_DIR = path.resolve(import.meta.dirname, '../../supabase/functions/admin-users');

// Source text without comments, so a comment that mentions Deno is not a use of it.
const code = (file: string) =>
  fs
    .readFileSync(path.join(FUNCTION_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('policy.ts has no imports and uses neither Deno nor the network', () => {
  const source = code('policy.ts');
  assert.doesNotMatch(source, /(^|[\s;])import[\s{('"*]/, 'an import');
  assert.doesNotMatch(source, /\brequire\s*\(/, 'a require');
  assert.doesNotMatch(source, /\bDeno\b/, 'Deno');
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|createClient)\b/, 'network use');
  assert.doesNotMatch(source, /https?:\/\//, 'a URL');
});

test('index.ts takes both decisions from ./policy.ts', () => {
  const source = code('index.ts');
  const imported = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]\.\/policy\.ts['"]/.exec(source);
  assert.ok(imported, 'index.ts does not import from ./policy.ts');
  assert.match(imported[1], /\bcallerMayAdminister\b/);
  assert.match(imported[1], /\btargetDecision\b/);
  // Imported and used: each name appears again outside the import.
  const rest = source.replace(imported[0], '');
  assert.match(rest, /\bcallerMayAdminister\s*\(/);
  assert.match(rest, /\btargetDecision\s*\(/);
});
