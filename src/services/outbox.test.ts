import assert from 'node:assert/strict';
import test from 'node:test';
import * as outboxModule from './outbox';
import { Outbox, MAX_ATTEMPTS, NoSessionError, PermanentSyncError, type OutboxItem } from './outbox';


/** Deterministic, valid UUIDs for fixtures - the outbox rejects other shapes. */
function uid(tag: string): string {
  const hex = [...tag].reduce((a, c) => a + c.charCodeAt(0).toString(16), '').padEnd(12, '0').slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}

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
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { depth: 4.55 });
  assert.equal(ob.depth(), 1);

  const t = transportThatFails();
  const result = await ob.drain(t.send, Date.parse('2026-08-05T10:00:00Z'));

  assert.deepEqual(t.sent, [uid('p-1')]);
  assert.equal(result.sent, 1);
  assert.equal(ob.depth(), 0);
});

test('drains oldest first so a borehole lands before records referencing it', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'borehole', uid('bh-1'), {});
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), {});
  ob.enqueue('upsert', 'pipeRecord', uid('p-2'), {});

  const t = transportThatFails();
  await ob.drain(t.send, Date.now());

  assert.deepEqual(t.sent, [uid('bh-1'), uid('p-1'), uid('p-2')]);
});

test('a failing item does not block the items behind it', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upload', 'photo', uid('photo-big'), {});
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), {});
  ob.enqueue('upsert', 'event', uid('e-1'), {});

  const t = transportThatFails([uid('photo-big')]);
  const result = await ob.drain(t.send, Date.now());

  // The stuck photo must not hold up the two small records behind it.
  assert.deepEqual(t.sent, [uid('p-1'), uid('e-1')]);
  assert.equal(result.failed, 1);
  assert.equal(ob.depth(), 1, 'only the photo remains pending');
});

test('failure schedules a backoff instead of retrying immediately', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), {});

  const t = transportThatFails([uid('p-1')]);
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
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { depth: 4.55 });

  const t = transportThatFails([uid('p-1')]);
  let now = Date.parse('2026-08-05T10:00:00Z');
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await ob.drain(t.send, now);
    now += 24 * 3600 * 1000;
  }

  assert.equal(ob.depth(), 0, 'parked work is not counted as pending');
  const parked = ob.parked();
  assert.equal(parked.length, 1);
  assert.equal(parked[0].entityId, uid('p-1'));
  assert.deepEqual(parked[0].payload, { depth: 4.55 }, 'payload preserved for recovery');
  assert.match(parked[0].lastError ?? '', /network down/);
});

test('a permanent rejection parks immediately instead of retrying for days', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), {});
  ob.enqueue('upsert', 'pipeRecord', uid('p-2'), {});

  let calls = 0;
  await ob.drain(async (item) => {
    calls++;
    if (item.entityId === uid('p-1')) {
      // e.g. the row belongs to another rig; no amount of waiting fixes it.
      throw new PermanentSyncError('row is owned by another user');
    }
  }, Date.now());

  assert.equal(calls, 2, 'the healthy item still went out');
  assert.equal(ob.depth(), 0);
  const parked = ob.parked();
  assert.equal(parked.length, 1);
  assert.equal(parked[0].entityId, uid('p-1'));
  assert.equal(parked[0].attempts, 1, 'parked on the first attempt, not the eighth');
});

test('repeated edits to one record coalesce into a single upload', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { remarks: 'first' });
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { remarks: 'second' });
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { remarks: 'final' });

  assert.equal(ob.depth(), 1, 'three edits, one pending upload');

  const seen: unknown[] = [];
  await ob.drain(async (item) => void seen.push(item.payload), Date.now());
  assert.deepEqual(seen, [{ remarks: 'final' }], 'latest state wins');
});

test('deleting a record that never uploaded cancels its pending upsert', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { remarks: 'typo' });
  ob.enqueue('delete', 'pipeRecord', uid('p-1'), {});

  const t = transportThatFails();
  await ob.drain(t.send, Date.now());

  // Sending an upsert for a record we are about to delete is pure waste on 2G.
  assert.deepEqual(t.attempted, [uid('p-1')]);
  assert.equal(ob.depth(), 0);
});

test('demo seed data is never enqueued', () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'borehole', uid('bh-2026-04'), { name: 'Kibera', isDemo: true });
  ob.enqueue('upsert', 'borehole', uid('bh-real'), { name: 'Real Site' });

  assert.equal(ob.depth(), 1, 'only the real borehole is queued');
  assert.equal(ob.pending()[0].entityId, uid('bh-real'));
});

test('queue survives a reload', async () => {
  harness();
  const first = new Outbox();
  first.enqueue('upsert', 'pipeRecord', uid('p-1'), { depth: 4.55 });

  const reloaded = new Outbox();
  assert.equal(reloaded.depth(), 1);
  assert.equal(reloaded.pending()[0].entityId, uid('p-1'));
});

test('enqueueing notifies subscribers so uploads can start immediately', async () => {
  harness();
  const ob = new Outbox();
  let nudges = 0;
  const off = ob.subscribe(() => nudges++);

  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), {});
  assert.equal(nudges, 1, 'a device already online must not sit on new work');

  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { edited: true });
  assert.equal(nudges, 2, 'a coalesced edit still needs a drain');

  off();
  ob.enqueue('upsert', 'pipeRecord', uid('p-2'), {});
  assert.equal(nudges, 2, 'unsubscribed listeners stop firing');
});

test('demo data does not trigger a pointless drain', () => {
  harness();
  const ob = new Outbox();
  let nudges = 0;
  ob.subscribe(() => nudges++);
  ob.enqueue('upsert', 'borehole', uid('bh-2026-04'), { isDemo: true });
  assert.equal(nudges, 0);
});

test('refuses to queue a record whose id is not a uuid', () => {
  harness();
  const ob = new Outbox();
  const originalError = console.error;
  const seen: string[] = [];
  console.error = (msg: unknown) => void seen.push(String(msg));
  try {
    // The shape a hand-rolled `bh-${Date.now()}` produces. Postgres rejects it,
    // so queueing it would strand the borehole and every record under it.
    const queued = ob.enqueue('upsert', 'borehole', 'bh-1786022504143', { name: 'X' });
    assert.equal(queued, null);
    assert.equal(ob.depth(), 0);
    assert.match(seen[0] ?? '', /non-uuid/);
  } finally {
    console.error = originalError;
  }
});

test('a device already online must not sit on queued work', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), {});
  ob.enqueue('upsert', 'pipeRecord', uid('p-2'), {});

  // Whatever wakes the worker - a connectivity event, an app resume, or the
  // periodic safety net - a drain must clear everything that is due. The bug
  // this guards against left three items sitting at attempts=0 next to a
  // working connection because the OS event never arrived.
  const t = transportThatFails();
  const result = await ob.drain(t.send, Date.now());

  assert.equal(result.sent, 2);
  assert.equal(ob.depth(), 0, 'nothing may be left pending after a successful drain');
});

// --- P2-5: queued work carries its organization ------------------------------

const ORG = '99999999-0000-4000-8000-000000000001';

test('enqueue stamps the cached active organization, and it survives a reload', () => {
  harness().set('wwdm_active_org', ORG);
  const queued = new Outbox().enqueue('upsert', 'borehole', uid('bh-1'), { name: 'Site' });

  assert.equal((queued as { orgId?: string }).orgId, ORG);
  assert.equal((new Outbox().pending()[0] as { orgId?: string }).orgId, ORG);
});

test('enqueue leaves the organization off when none is cached', () => {
  harness();
  const queued = new Outbox().enqueue('upsert', 'borehole', uid('bh-1'), { name: 'Site' });

  assert.ok(queued);
  assert.equal('orgId' in queued, false, 'no orgId key, so it is sent as an old item is');
});

// --- RF-125: a drain without a session is not an attempt ----------------------

test('drains without a session never count, back off or park; the work goes once there is one', async () => {
  harness();
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { depth: 4.55 });
  const before = ob.pending()[0].nextAttemptAt;
  const now = Date.parse('2026-08-05T10:00:00Z');

  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    const r = await ob.drain(async () => {
      throw new NoSessionError('no active session');
    }, now);
    assert.deepEqual(r, { sent: 0, failed: 1, parked: 0 });
  }
  const [held] = ob.pending();
  assert.equal(held.attempts, 0);
  assert.equal(held.nextAttemptAt, before);
  assert.equal(ob.parked().length, 0);

  const t = transportThatFails();
  await ob.drain(t.send, now);
  assert.deepEqual(t.sent, [uid('p-1')], 'sent at once, with no backoff to wait out');
});

// --- P3-3: work refused by the subscription is held (criterion 2) -------------
// Assumed, beside NoSessionError in outbox.ts:
//   export class SubscriptionHeldError extends Error {}   // new SubscriptionHeldError(message)
// Read through the namespace so this file type-checks before the class exists.

test('work refused by the subscription never counts, backs off or parks; it goes once the refusal stops', async () => {
  harness();
  const { SubscriptionHeldError } = outboxModule as unknown as { SubscriptionHeldError: new (m: string) => Error };
  const ob = new Outbox();
  ob.enqueue('upsert', 'pipeRecord', uid('p-1'), { depth: 4.55 });
  const before = ob.pending()[0].nextAttemptAt;
  const now = Date.parse('2026-08-05T10:00:00Z');

  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    const r = await ob.drain(async () => {
      throw new SubscriptionHeldError('subscription expired');
    }, now);
    assert.equal(r.sent, 0);
    assert.equal(r.parked, 0);
  }
  const [held] = ob.pending();
  assert.equal(held.attempts, 0);
  assert.equal(held.nextAttemptAt, before);
  assert.equal(ob.parked().length, 0);

  const t = transportThatFails();
  await ob.drain(t.send, now);
  assert.deepEqual(t.sent, [uid('p-1')], 'sent at once after renewal, with no backoff to wait out');
  assert.equal(ob.depth(), 0);
});
