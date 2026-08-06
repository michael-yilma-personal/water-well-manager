import assert from 'node:assert/strict';
import test from 'node:test';
import { Outbox, MAX_ATTEMPTS, PermanentSyncError, type OutboxItem } from './outbox';

function harness() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  return store;
}

/** Transport that fails for entityIds listed in `failing`, recording what it saw. */
function transportThatFails(failing: string[] = []) {
  const sent: string[] = [];
  const attempted: string[] = [];
  return {
    sent,
    attempted,
    send: async (item: OutboxItem) => {
      attempted.push(item.entityId);
      if (failing.includes(item.entityId)) throw new Error('network down');
      sent.push(item.entityId);
    },
  };
}

test('enqueue makes work pending and drain clears it', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', 'p-1', { depth: 4.55 });
  assert.equal(ob.depth(), 1);

  const t = transportThatFails();
  const result = await ob.drain(t.send, Date.parse('2026-08-05T10:00:00Z'));

  assert.deepEqual(t.sent, ['p-1']);
  assert.equal(result.sent, 1);
  assert.equal(ob.depth(), 0);
});

test('drains oldest first so a borehole lands before records referencing it', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'borehole', 'bh-1', {});
  ob.enqueue('upsert', 'pipeRecord', 'p-1', {});
  ob.enqueue('upsert', 'pipeRecord', 'p-2', {});

  const t = transportThatFails();
  await ob.drain(t.send, Date.now());

  assert.deepEqual(t.sent, ['bh-1', 'p-1', 'p-2']);
});

test('a failing item does not block the items behind it', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upload', 'photo', 'photo-big', {});
  ob.enqueue('upsert', 'pipeRecord', 'p-1', {});
  ob.enqueue('upsert', 'event', 'e-1', {});

  const t = transportThatFails(['photo-big']);
  const result = await ob.drain(t.send, Date.now());

  // The stuck photo must not hold up the two small records behind it.
  assert.deepEqual(t.sent, ['p-1', 'e-1']);
  assert.equal(result.failed, 1);
  assert.equal(ob.depth(), 1, 'only the photo remains pending');
});

test('failure schedules a backoff instead of retrying immediately', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', 'p-1', {});

  const t = transportThatFails(['p-1']);
  const now = Date.parse('2026-08-05T10:00:00Z');
  await ob.drain(t.send, now);
  assert.equal(t.attempted.length, 1);

  // Immediately draining again must not touch it - it is backing off.
  await ob.drain(t.send, now + 1000);
  assert.equal(t.attempted.length, 1, 'retried too early');

  // Once the backoff has elapsed it is attempted again.
  await ob.drain(t.send, now + 60_000);
  assert.equal(t.attempted.length, 2);
});

test('an item that keeps failing is parked, never discarded', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', 'p-1', { depth: 4.55 });

  const t = transportThatFails(['p-1']);
  let now = Date.parse('2026-08-05T10:00:00Z');
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await ob.drain(t.send, now);
    now += 24 * 3600 * 1000;
  }

  assert.equal(ob.depth(), 0, 'parked work is not counted as pending');
  const parked = ob.parked();
  assert.equal(parked.length, 1);
  assert.equal(parked[0].entityId, 'p-1');
  assert.deepEqual(parked[0].payload, { depth: 4.55 }, 'payload preserved for recovery');
  assert.match(parked[0].lastError ?? '', /network down/);
});

test('a permanent rejection parks immediately instead of retrying for days', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', 'p-1', {});
  ob.enqueue('upsert', 'pipeRecord', 'p-2', {});

  let calls = 0;
  await ob.drain(async (item) => {
    calls++;
    if (item.entityId === 'p-1') {
      // e.g. the row belongs to another rig; no amount of waiting fixes it.
      throw new PermanentSyncError('row is owned by another user');
    }
  }, Date.now());

  assert.equal(calls, 2, 'the healthy item still went out');
  assert.equal(ob.depth(), 0);
  const parked = ob.parked();
  assert.equal(parked.length, 1);
  assert.equal(parked[0].entityId, 'p-1');
  assert.equal(parked[0].attempts, 1, 'parked on the first attempt, not the eighth');
});

test('repeated edits to one record coalesce into a single upload', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', 'p-1', { remarks: 'first' });
  ob.enqueue('upsert', 'pipeRecord', 'p-1', { remarks: 'second' });
  ob.enqueue('upsert', 'pipeRecord', 'p-1', { remarks: 'final' });

  assert.equal(ob.depth(), 1, 'three edits, one pending upload');

  const seen: unknown[] = [];
  await ob.drain(async (item) => void seen.push(item.payload), Date.now());
  assert.deepEqual(seen, [{ remarks: 'final' }], 'latest state wins');
});

test('deleting a record that never uploaded cancels its pending upsert', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', 'p-1', { remarks: 'typo' });
  ob.enqueue('delete', 'pipeRecord', 'p-1', {});

  const t = transportThatFails();
  await ob.drain(t.send, Date.now());

  // Sending an upsert for a record we are about to delete is pure waste on 2G.
  assert.deepEqual(t.attempted, ['p-1']);
  assert.equal(ob.depth(), 0);
});

test('demo seed data is never enqueued', () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'borehole', 'bh-2026-04', { name: 'Kibera', isDemo: true });
  ob.enqueue('upsert', 'borehole', 'bh-real', { name: 'Real Site' });

  assert.equal(ob.depth(), 1, 'only the real borehole is queued');
  assert.equal(ob.pending()[0].entityId, 'bh-real');
});

test('queue survives a reload', async () => {
  harness();
  const first = new Outbox();
  first.enqueue('upsert', 'pipeRecord', 'p-1', { depth: 4.55 });

  const reloaded = new Outbox();
  assert.equal(reloaded.depth(), 1);
  assert.equal(reloaded.pending()[0].entityId, 'p-1');
});

test('enqueueing notifies subscribers so uploads can start immediately', async () => {
  harness();
  const ob = new Outbox();
  let nudges = 0;
  const off = ob.subscribe(() => nudges++);

  ob.enqueue('upsert', 'pipeRecord', 'p-1', {});
  assert.equal(nudges, 1, 'a device already online must not sit on new work');

  ob.enqueue('upsert', 'pipeRecord', 'p-1', { edited: true });
  assert.equal(nudges, 2, 'a coalesced edit still needs a drain');

  off();
  ob.enqueue('upsert', 'pipeRecord', 'p-2', {});
  assert.equal(nudges, 2, 'unsubscribed listeners stop firing');
});

test('demo data does not trigger a pointless drain', () => {
  harness();
  const ob = new Outbox();
  let nudges = 0;
  ob.subscribe(() => nudges++);
  ob.enqueue('upsert', 'borehole', 'bh-2026-04', { isDemo: true });
  assert.equal(nudges, 0);
});
