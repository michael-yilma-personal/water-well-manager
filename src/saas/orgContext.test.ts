import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as orgContext from './orgContext';
import { mayActivate, rememberOrg, rememberedOrg, resolveActiveOrg } from './orgContext';

type Status = 'invited' | 'active' | 'deactivated';
const m = (orgId: string, status: Status) => ({ orgId, name: `Org ${orgId}`, role: 'member', status });

test('the remembered organization is kept while its membership is still active', () => {
  const list = [m('a', 'active'), m('b', 'active')];
  assert.deepEqual(resolveActiveOrg(list, 'b'), { kind: 'active', orgId: 'b' });
});

test('exactly one active membership is chosen without asking', () => {
  assert.deepEqual(resolveActiveOrg([m('a', 'invited'), m('b', 'active')], null), { kind: 'active', orgId: 'b' });
});

test('a remembered organization that is no longer active is never the active one', () => {
  assert.deepEqual(resolveActiveOrg([m('a', 'deactivated'), m('b', 'active')], 'a'), { kind: 'active', orgId: 'b' });
  assert.deepEqual(resolveActiveOrg([m('a', 'invited'), m('b', 'active'), m('c', 'active')], 'a'), { kind: 'choose' });
  assert.deepEqual(resolveActiveOrg([m('b', 'active'), m('c', 'active')], 'gone'), { kind: 'choose' });
});

test('several active memberships and nothing remembered: the user must choose', () => {
  assert.deepEqual(resolveActiveOrg([m('a', 'active'), m('b', 'active')], null), { kind: 'choose' });
});

test('with no active membership it says why, and a remembered choice changes nothing', () => {
  assert.deepEqual(resolveActiveOrg([], 'a'), { kind: 'none', reason: 'no-membership' });
  assert.deepEqual(resolveActiveOrg([m('a', 'invited'), m('b', 'deactivated')], 'a'), { kind: 'none', reason: 'invited-only' });
  assert.deepEqual(resolveActiveOrg([m('a', 'deactivated')], 'a'), { kind: 'none', reason: 'deactivated' });
});

test('only an active membership of the caller may be activated', () => {
  const list = [m('a', 'active'), m('b', 'invited'), m('c', 'deactivated')];
  assert.equal(mayActivate('a', list), true);
  assert.equal(mayActivate('b', list), false);
  assert.equal(mayActivate('c', list), false);
  assert.equal(mayActivate('not-mine', list), false);
  assert.equal(mayActivate('a', []), false);
});

test('a second person on the same browser never inherits the first one\'s organization', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  assert.equal(rememberedOrg(storage, 'user-1'), null);
  rememberOrg(storage, 'user-1', 'a');
  assert.equal(rememberedOrg(storage, 'user-1'), 'a');
  assert.equal(rememberedOrg(storage, 'user-2'), null);
  rememberOrg(storage, 'user-2', 'b');
  assert.equal(rememberedOrg(storage, 'user-1'), 'a');
});

// The boundary of a reusable folder (proposal 11). `sibling`: another reusable folder it may import from.
function checkBoundary(folder: string, sibling?: string) {
  const dir = fileURLToPath(new URL(`../${folder}/`, import.meta.url));
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f) && !/\.test\.[a-z]+$/.test(f));
  assert.ok(files.length > 0, `src/${folder} holds no implementation file`);
  const drill = ['boreholes', 'pipe_records', 'drilling_events', 'shift_logs', 'profiles',
    'Driller', 'Data Logger', 'Supervisor', 'Administrator', 'drilling-photos'];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const depth = file.split(/[\\/]/).length - 1;
    for (const [, spec] of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const prefix = `${'../'.repeat(depth + 1)}${sibling}/`;
      if (sibling && spec.startsWith(prefix) && !spec.slice(prefix.length).includes('..')) continue;
      const ups = spec.split('/').filter((p) => p === '..').length;
      assert.ok(ups <= depth && !/^(@\/|~\/|src\/|\/)/.test(spec), `${file} imports ${spec}`);
    }
    for (const name of drill) assert.ok(!text.includes(name), `${file} names ${name}`);
  }
}

test('src/saas imports nothing from the rest of src and names nothing of Drill', () => checkBoundary('saas'));

// P4-3. Red until src/platform holds an implementation file (its tests do not count).
test('src/platform imports nothing from src but src/saas and names nothing of Drill', () => checkBoundary('platform', 'saas'));

// --- P3-3: the subscription notice (criteria 1, 7) ----------------------------
// Assumed, in src/saas/orgContext.ts:
//   subscriptionNotice(access: 'full' | 'read_only' | 'none' | null | undefined,
//                      endsAt: string | null | undefined, now: number /* epoch ms */)
//     : 'grace' | 'expired' | 'inactive' | null
// Read through the namespace so this file type-checks before the function exists.
type Notice = 'grace' | 'expired' | 'inactive' | null;
const subscriptionNotice = (access: string | null | undefined, endsAt: string | null | undefined, now: number): Notice =>
  (orgContext as unknown as { subscriptionNotice: (a: typeof access, e: typeof endsAt, n: number) => Notice })
    .subscriptionNotice(access, endsAt, now);

const NOW = Date.parse('2026-11-25T12:00:00Z');
const PAST = '2026-11-20T00:00:00Z';
const FUTURE = '2026-12-20T00:00:00Z';

test('the notice follows the access level and the end date, and good standing has none', () => {
  assert.equal(subscriptionNotice('full', null, NOW), null);
  assert.equal(subscriptionNotice('full', FUTURE, NOW), null);
  assert.equal(subscriptionNotice('full', PAST, NOW), 'grace');
  assert.equal(subscriptionNotice('read_only', PAST, NOW), 'expired');
  assert.equal(subscriptionNotice('none', PAST, NOW), 'inactive');
  assert.equal(subscriptionNotice('none', null, NOW), 'inactive', 'suspended with no end date');
});

test('no access level read yet is treated as full: no notice', () => {
  assert.equal(subscriptionNotice(null, null, NOW), null);
  assert.equal(subscriptionNotice(undefined, undefined, NOW), null);
});

// --- P4-5 (RF-161): a waiting invitation is offered next to an active organization ---
// Assumed, in src/saas/orgContext.ts:
//   invitationsToOffer(memberships: Membership[], activeOrgId: string | null): Membership[]
// The invited memberships, in the order given, whether or not an organization is active.
// Accepting one turns it active; resolveActiveOrg then keeps the remembered organization.
const invitationsToOffer = (list: ReturnType<typeof m>[], activeOrgId: string | null) =>
  (orgContext as unknown as { invitationsToOffer: (l: typeof list, a: string | null) => typeof list })
    .invitationsToOffer(list, activeOrgId);

test('a waiting invitation is offered while another organization is active, and accepting it does not switch', () => {
  const before = [m('a', 'active'), m('b', 'invited'), m('c', 'deactivated'), m('d', 'invited')];
  assert.deepEqual(invitationsToOffer(before, 'a'), [m('b', 'invited'), m('d', 'invited')]);
  assert.deepEqual(invitationsToOffer(before, null), [m('b', 'invited'), m('d', 'invited')]);
  assert.deepEqual(invitationsToOffer([m('a', 'active'), m('c', 'deactivated')], 'a'), []);
  const after = [m('a', 'active'), m('b', 'active'), m('c', 'deactivated'), m('d', 'invited')];
  assert.deepEqual(resolveActiveOrg(after, 'a'), { kind: 'active', orgId: 'a' });
  assert.deepEqual(invitationsToOffer(after, 'a'), [m('d', 'invited')]);
});
