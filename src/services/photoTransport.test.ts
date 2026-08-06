import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompositeTransport } from './photoTransport';
import type { OutboxItem } from './outbox';

function item(entity: OutboxItem['entity']): OutboxItem {
  return {
    id: 'op-1',
    op: entity === 'photo' ? 'upload' : 'upsert',
    entity,
    entityId: 'x',
    payload: {},
    attempts: 0,
    enqueuedAt: '2026-08-06T00:00:00.000Z',
    nextAttemptAt: 0,
  };
}

test('photo operations go to object storage, records go to tables', async () => {
  const seen: string[] = [];
  const send = createCompositeTransport(
    async () => void seen.push('record'),
    async () => void seen.push('photo')
  );

  await send(item('pipeRecord'));
  await send(item('photo'));
  await send(item('event'));
  await send(item('borehole'));

  assert.deepEqual(seen, ['record', 'photo', 'record', 'record']);
});

test('a failing photo upload propagates so the queue can retry it alone', async () => {
  const send = createCompositeTransport(
    async () => {},
    async () => {
      throw new Error('link dropped mid-upload');
    }
  );
  await assert.rejects(send(item('photo')), /link dropped/);
});
