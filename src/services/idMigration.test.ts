import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateRecordIdsToUuid, isUuid, STORAGE_KEYS_FOR_MIGRATION } from './idMigration';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function harness(seed: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(seed)) store.set(k, JSON.stringify(v));
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
  return {
    read: <T>(k: string): T => JSON.parse(store.get(k) ?? 'null') as T,
    raw: store,
  };
}

const K = STORAGE_KEYS_FOR_MIGRATION;

test('rewrites legacy ids to uuids', () => {
  const h = harness({
    [K.BOREHOLES]: [{ id: 'bh-2026-04', name: 'Kibera' }],
    [K.PIPE_RECORDS]: [{ id: 'p-mdk3f-1', boreholeId: 'bh-2026-04', pipeNumber: 1 }],
  });

  const report = migrateRecordIdsToUuid();

  const boreholes = h.read<{ id: string }[]>(K.BOREHOLES);
  assert.match(boreholes[0].id, UUID_RE);
  assert.equal(report.migrated, 2);
});

test('repoints child records at the boreholes new id', () => {
  const h = harness({
    [K.BOREHOLES]: [{ id: 'bh-2026-04', name: 'Kibera' }],
    [K.PIPE_RECORDS]: [
      { id: 'p-a', boreholeId: 'bh-2026-04', pipeNumber: 1 },
      { id: 'p-b', boreholeId: 'bh-2026-04', pipeNumber: 2 },
    ],
    [K.EVENTS]: [{ id: 'e-a', boreholeId: 'bh-2026-04', type: 'Breakdown' }],
    [K.SHIFT_LOGS]: [{ id: 's-a', boreholeId: 'bh-2026-04' }],
  });

  migrateRecordIdsToUuid();

  const newBoreholeId = h.read<{ id: string }[]>(K.BOREHOLES)[0].id;
  const pipes = h.read<{ boreholeId: string }[]>(K.PIPE_RECORDS);
  const events = h.read<{ boreholeId: string }[]>(K.EVENTS);
  const shifts = h.read<{ boreholeId: string }[]>(K.SHIFT_LOGS);

  assert.deepEqual(
    pipes.map((p) => p.boreholeId),
    [newBoreholeId, newBoreholeId],
    'orphaned pipe records would be unreachable forever'
  );
  assert.equal(events[0].boreholeId, newBoreholeId);
  assert.equal(shifts[0].boreholeId, newBoreholeId);
});

test('repoints the active borehole selection and the running pipe timer', () => {
  const h = harness({
    [K.BOREHOLES]: [{ id: 'bh-2026-04', name: 'Kibera' }],
    [K.ACTIVE_TIMER]: { 'bh-2026-04': { boreholeId: 'bh-2026-04', pipeNumber: 21 } },
  });
  // Bare string, matching DrillingStorage.setActiveBorehole.
  h.raw.set(K.ACTIVE_BOREHOLE_ID, 'bh-2026-04');

  migrateRecordIdsToUuid();

  const newId = h.read<{ id: string }[]>(K.BOREHOLES)[0].id;
  assert.equal(h.raw.get(K.ACTIVE_BOREHOLE_ID), newId);

  // The timer map is keyed by borehole id; a stale key means a driller's
  // in-progress pipe silently disappears after the upgrade.
  const timers = h.read<Record<string, { boreholeId: string }>>(K.ACTIVE_TIMER);
  assert.deepEqual(Object.keys(timers), [newId]);
  assert.equal(timers[newId].boreholeId, newId);
});

test('is idempotent - a second run changes nothing', () => {
  const h = harness({
    [K.BOREHOLES]: [{ id: 'bh-2026-04', name: 'Kibera' }],
    [K.PIPE_RECORDS]: [{ id: 'p-a', boreholeId: 'bh-2026-04' }],
  });

  migrateRecordIdsToUuid();
  const afterFirst = JSON.stringify(h.read(K.BOREHOLES)) + JSON.stringify(h.read(K.PIPE_RECORDS));

  const second = migrateRecordIdsToUuid();
  const afterSecond = JSON.stringify(h.read(K.BOREHOLES)) + JSON.stringify(h.read(K.PIPE_RECORDS));

  assert.equal(afterFirst, afterSecond);
  assert.equal(second.migrated, 0, 'already-migrated data must not be rewritten');
});

test('a child pointing at a missing borehole is flagged, not dropped', () => {
  const h = harness({
    [K.BOREHOLES]: [{ id: 'bh-2026-04' }],
    [K.PIPE_RECORDS]: [
      { id: 'p-a', boreholeId: 'bh-2026-04' },
      { id: 'p-orphan', boreholeId: 'bh-deleted-long-ago' },
    ],
  });

  const report = migrateRecordIdsToUuid();

  const pipes = h.read<{ id: string; boreholeId: string; orphaned?: boolean }[]>(K.PIPE_RECORDS);
  assert.equal(pipes.length, 2, 'no record may be silently discarded');
  const orphan = pipes.find((p) => p.boreholeId === 'bh-deleted-long-ago');
  assert.ok(orphan, 'unresolvable parent id is left intact for inspection');
  assert.equal(orphan!.orphaned, true);
  assert.equal(report.orphaned, 1);
});

test('handles a device with no data yet', () => {
  harness();
  const report = migrateRecordIdsToUuid();
  assert.equal(report.migrated, 0);
  assert.equal(report.orphaned, 0);
});

test('creates no storage keys on a fresh install', () => {
  const h = harness();

  migrateRecordIdsToUuid();

  // Seeding is gated on the key being absent (`if (!raw)`). Writing an empty
  // array here would convince storage that demo data had already been created,
  // leaving the app with no boreholes at all and crashing the header.
  assert.deepEqual([...h.raw.keys()], [], 'migration must not fabricate keys');
});

test('writes the active borehole id in the raw form storage reads back', () => {
  const h = harness({
    [K.BOREHOLES]: [{ id: 'bh-2026-04' }],
  });
  // Stored bare by DrillingStorage.setActiveBorehole, not JSON-encoded.
  h.raw.set(K.ACTIVE_BOREHOLE_ID, 'bh-2026-04');

  migrateRecordIdsToUuid();

  const newId = h.read<{ id: string }[]>(K.BOREHOLES)[0].id;
  const stored = h.raw.get(K.ACTIVE_BOREHOLE_ID);
  assert.equal(stored, newId, 'a JSON-quoted id will not match any borehole');
  assert.ok(!stored!.startsWith('"'), 'must not be JSON-encoded');
});

test('isUuid distinguishes migrated ids from legacy ones', () => {
  assert.equal(isUuid('bh-2026-04'), false);
  assert.equal(isUuid('p-mdk3f-1'), false);
  assert.equal(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true);
});
