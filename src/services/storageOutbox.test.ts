import assert from 'node:assert/strict';
import test from 'node:test';
import { DrillingStorage, getOutbox, resetOutbox } from './storage';
import type { PipeRecord, DrillingEvent } from '../types';


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
  resetOutbox();
  return store;
}

function pipe(overrides: Partial<PipeRecord> = {}): PipeRecord {
  return {
    id: '',
    boreholeId: '00000000-0000-4000-8000-00000000bb01',
    pipeNumber: 1,
    startDepth: 0,
    endDepth: 4.55,
    pipeLength: 4.55,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    durationSeconds: 900,
    penetrationRate: 18.2,
    formation: 'Topsoil & Alluvium',
    waterStrike: false,
    airPressure: 240,
    compressorPressure: 210,
    bitType: 'DTH Hammer - Button Bit',
    bitDiameter: 8.5,
    operator: 'James Wanjala',
    remarks: '',
    synced: false,
    ...overrides,
  } as PipeRecord;
}

test('saving a real pipe record queues it for upload', () => {
  harness();
  // Reading first seeds demo data; clear the queue so we measure only our save.
  DrillingStorage.getPipeRecords();
  getOutbox().clear();

  const saved = DrillingStorage.savePipeRecord(pipe({ id: '' }));

  const queued = getOutbox().pending();
  const forPipe = queued.filter((q) => q.entity === 'pipeRecord');
  assert.equal(forPipe.length, 1);
  assert.equal(forPipe[0].entityId, saved.id);
  assert.equal(forPipe[0].op, 'upsert');
});

test('seeded demo records are never queued', () => {
  harness();
  // Triggers demo seeding of boreholes, pipes and events.
  DrillingStorage.getBoreholes();
  DrillingStorage.getPipeRecords();
  DrillingStorage.getEvents();

  assert.equal(
    getOutbox().depth(),
    0,
    'demo seed data must not be pushed - every install ships identical ids'
  );
});

test('the pending badge reflects queue depth, not the stale synced flag', () => {
  harness();
  DrillingStorage.getPipeRecords();
  getOutbox().clear();
  assert.equal(DrillingStorage.getPendingSyncCount(), 0);

  DrillingStorage.savePipeRecord(pipe({ id: '' }));
  DrillingStorage.savePipeRecord(pipe({ id: '', pipeNumber: 2 }));

  // Two pipes, plus the borehole row each save touches if depth advanced.
  assert.ok(
    DrillingStorage.getPendingSyncCount() >= 2,
    `expected at least 2 pending, got ${DrillingStorage.getPendingSyncCount()}`
  );
});

test('the parent borehole is queued ahead of the record that references it', () => {
  harness();
  // A borehole that reached storage without being queued - restored from a
  // backup, or created before syncing existed.
  DrillingStorage.getBoreholes();
  localStorage.setItem(
    'wwdm_boreholes',
    JSON.stringify([
      {
        id: '00000000-0000-4000-8000-00000000bh01'.replace('bh01', 'aa01'),
        name: 'BH-REAL',
        currentDepth: 0,
        gpsCoordinates: { lat: 0, lng: 0 },
      },
    ])
  );
  DrillingStorage.getPipeRecords();
  getOutbox().clear();

  DrillingStorage.savePipeRecord(
    pipe({ id: '', boreholeId: '00000000-0000-4000-8000-00000000aa01' })
  );

  const order = getOutbox().pending().map((q) => q.entity);
  const boreholeAt = order.indexOf('borehole');
  const pipeAt = order.indexOf('pipeRecord');
  assert.notEqual(boreholeAt, -1, 'parent must be queued at all');
  assert.ok(
    boreholeAt < pipeAt,
    `the queue drains oldest-first, so a child sent first hits a foreign key ` +
      `violation. Got order: ${order.join(', ')}`
  );
});

test('deleting a saved record queues a delete', () => {
  harness();
  DrillingStorage.getPipeRecords();
  const saved = DrillingStorage.savePipeRecord(pipe({ id: '' }));
  getOutbox().clear();

  DrillingStorage.deletePipeRecord(saved.id);

  const queued = getOutbox().pending();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].op, 'delete');
  assert.equal(queued[0].entityId, saved.id);
});

test('deleting a demo record does not queue anything', () => {
  harness();
  const demoPipes = DrillingStorage.getPipeRecords();
  getOutbox().clear();
  assert.ok(demoPipes.length > 0, 'expected seeded demo pipes');

  DrillingStorage.deletePipeRecord(demoPipes[0].id);

  assert.equal(getOutbox().depth(), 0, 'a demo row has no server-side counterpart');
});

test('saved events are queued and carry a uuid', () => {
  harness();
  DrillingStorage.getEvents();
  getOutbox().clear();

  const saved = DrillingStorage.saveEvent({
    id: '',
    boreholeId: '00000000-0000-4000-8000-00000000bb01',
    type: 'Breakdown',
    title: 'Hydraulic hose burst',
    timestamp: new Date().toISOString(),
    depthAtEvent: 91,
    durationMinutes: 25,
    isNPT: true,
    operator: 'James Wanjala',
    details: {},
    synced: false,
  } as DrillingEvent);

  assert.match(
    saved.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'ids must be globally unique so two rigs cannot collide'
  );
  const queued = getOutbox().pending().filter((q) => q.entity === 'event');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].entityId, saved.id);
});

test('linking a device clears sample data but keeps real records', () => {
  harness();
  DrillingStorage.getBoreholes();
  DrillingStorage.getPipeRecords();
  DrillingStorage.getEvents();
  const seededPipes = DrillingStorage.getPipeRecords().length;
  assert.ok(seededPipes > 0, 'expected seeded demo pipes');

  // A record the crew actually logged, on a real borehole.
  const real = DrillingStorage.savePipeRecord(pipe({ id: '', boreholeId: '00000000-0000-4000-8000-00000000bb01' }));

  const removed = DrillingStorage.clearDemoData();

  assert.ok(removed >= seededPipes, `removed ${removed}`);
  const left = DrillingStorage.getPipeRecords();
  assert.equal(left.length, 1, 'only the real record survives');
  assert.equal(left[0].id, real.id);
  assert.ok(
    DrillingStorage.getBoreholes().every((b) => !b.isDemo),
    'no demo boreholes remain'
  );
});

test('clearing sample data leaves no dangling active borehole', () => {
  harness();
  DrillingStorage.getBoreholes();
  DrillingStorage.setActiveBorehole('bh-2026-04');

  DrillingStorage.clearDemoData();

  const active = localStorage.getItem('wwdm_active_borehole_id');
  assert.ok(
    active === null || DrillingStorage.getBoreholes().some((b) => b.id === active),
    `active borehole ${active} no longer exists`
  );
});
