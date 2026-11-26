import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncWorker } from './syncWorker';
import type { Outbox } from './outbox';

// RF-125: without a session the worker does not drain at all.
test('syncNow drains only when there is a session to send with', async () => {
  let drains = 0;
  let session = false;
  const outbox = { depth: () => 1, drain: async () => (drains++, { sent: 1, failed: 0, parked: 0 }) };
  const worker = new SyncWorker({
    outbox: outbox as unknown as Outbox,
    transport: async () => {},
    hasSession: async () => session,
  });

  assert.deepEqual(await worker.syncNow(), { sent: 0, failed: 0, parked: 0 });
  assert.equal(drains, 0);
  session = true;
  await worker.syncNow();
  assert.equal(drains, 1, 'the same worker drains once the session is back');
});
