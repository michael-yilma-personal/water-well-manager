import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompositeTransport, createPhotoTransport } from './photoTransport';
import { NoSessionError, type OutboxItem } from './outbox';

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

// --- P2-5: photos are stored under the organization --------------------------

const UID = '11111111-2222-3333-4444-555555555555';
const ORG = '99999999-0000-4000-8000-000000000001';

/** Uploads one photo and returns the object paths it was stored under. */
async function uploadedPaths(orgId?: string): Promise<string[]> {
  // The device's photo store (IndexedDB off a phone): every file reads back.
  const req = (result: unknown) => {
    const r: { result: unknown; onsuccess?: () => void } = { result };
    queueMicrotask(() => r.onsuccess?.());
    return r;
  };
  const db = { transaction: () => ({ objectStore: () => ({ get: () => req({ content: 'AAAA' }) }) }) };
  const g = globalThis as Record<string, unknown>;
  g.indexedDB = { open: () => req(db) };
  g.window = g;

  const paths: string[] = [];
  const upload = async (path: string) => (paths.push(path), { error: null });
  const send = createPhotoTransport({
    getClient: () => ({ storage: { from: () => ({ upload }) } }) as never,
    getUserId: async () => UID,
  });
  await send({ ...item('photo'), payload: { photoId: 'p1' }, ...(orgId ? { orgId } : {}) });
  return paths;
}

test('a photo captured in an organization uploads to <org>/<user>/<file>', async () => {
  const paths = await uploadedPaths(ORG);
  assert.equal(paths.length, 2, 'thumbnail and full image');
  for (const p of paths) assert.match(p, new RegExp(`^${ORG}/${UID}/[^/]+$`));
});

test('a photo queued before the update uploads to the legacy <user>/<file> path', async () => {
  const paths = await uploadedPaths();
  assert.equal(paths.length, 2);
  for (const p of paths) assert.match(p, new RegExp(`^${UID}/[^/]+$`));
});

test('a photo without a session is not uploaded and is not counted as an attempt (RF-125)', async () => {
  let asked = 0;
  const send = createPhotoTransport({
    getClient: () => ({ storage: { from: () => (asked++, {}) } }) as never,
    getUserId: async () => null,
  });
  await assert.rejects(send({ ...item('photo'), payload: { photoId: 'p1' } }), NoSessionError);
  assert.equal(asked, 0);
});
