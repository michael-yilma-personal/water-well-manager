import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('src/saas imports nothing from the rest of src and names nothing of Drill', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f) && !/\.test\.[a-z]+$/.test(f));
  assert.ok(files.length > 0, 'src/saas holds no implementation file');
  const drill = ['boreholes', 'pipe_records', 'drilling_events', 'shift_logs', 'profiles',
    'Driller', 'Data Logger', 'Supervisor', 'Administrator', 'drilling-photos'];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const depth = file.split(/[\\/]/).length - 1;
    for (const [, spec] of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const ups = spec.split('/').filter((p) => p === '..').length;
      assert.ok(ups <= depth && !/^(@\/|~\/|src\/|\/)/.test(spec), `${file} imports ${spec}`);
    }
    for (const name of drill) assert.ok(!text.includes(name), `${file} names ${name}`);
  }
});
