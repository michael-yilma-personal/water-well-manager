import assert from 'node:assert/strict';
import test from 'node:test';
import { DrillingStorage, getOutbox, resetOutbox } from './storage';
import type { Borehole, PipeRecord } from '../types';

/**
 * Merging the server's copy back onto the device.
 *
 * The dangerous direction is not the download itself but what it overwrites: a
 * driller may have logged for hours with no signal, and a pull that lands on
 * top of that work destroys records that were never uploaded. Unsent local work
 * therefore always beats the server's version of the same row.
 */

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

const BH_A = '00000000-0000-4000-8000-0000000000a1';
const PIPE_A = '00000000-0000-4000-8000-0000000000p1'.replace('p', 'f');

function borehole(overrides: Partial<Borehole> = {}): Borehole {
  return {
    id: BH_A,
    name: 'BH-REMOTE',
    project: 'Kitui',
    client: 'County',
    rigName: 'Rig #2',
    targetDepth: 120,
    currentDepth: 18.2,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer',
    status: 'active',
    createdAt: '2026-08-30T06:00:00.000Z',
    updatedAt: '2026-08-30T06:00:00.000Z',
    ...overrides,
  } as Borehole;
}

function pipe(overrides: Partial<PipeRecord> = {}): PipeRecord {
  return {
    id: PIPE_A,
    boreholeId: BH_A,
    pipeNumber: 1,
    startDepth: 0,
    endDepth: 4.55,
    pipeLength: 4.55,
    formation: 'Topsoil & Alluvium',
    waterStrike: false,
    operator: 'Remote Driller',
    remarks: '',
    synced: true,
    ...overrides,
  } as PipeRecord;
}

test('a borehole logged on another device appears on this one', () => {
  harness();
  DrillingStorage.clearDemoData();

  DrillingStorage.mergeRemote({
    boreholes: [borehole()],
    pipeRecords: [pipe()],
    events: [],
    shiftLogs: [],
    deletedIds: [],
  });

  const names = DrillingStorage.getBoreholes().map((b) => b.name);
  assert.deepEqual(names, ['BH-REMOTE']);
  assert.equal(DrillingStorage.getPipeRecords(BH_A).length, 1);
});

test('a pull never overwrites a record that has not been uploaded yet', () => {
  harness();
  DrillingStorage.clearDemoData();

  // Logged at the rig with no signal: saved locally, still in the outbox.
  DrillingStorage.savePipeRecord(pipe({ id: PIPE_A, endDepth: 9.1, operator: 'Me' }));
  assert.equal(DrillingStorage.getPendingSyncCount() > 0, true);

  // The server still holds an older copy of that same record.
  DrillingStorage.mergeRemote({
    boreholes: [],
    pipeRecords: [pipe({ id: PIPE_A, endDepth: 4.55, operator: 'Stale' })],
    events: [],
    shiftLogs: [],
    deletedIds: [],
  });

  const [kept] = DrillingStorage.getPipeRecords(BH_A);
  assert.equal(kept.endDepth, 9.1, 'unsent local work must win over the server copy');
  assert.equal(kept.operator, 'Me');
});

test('a record deleted on another device disappears here too', () => {
  harness();
  DrillingStorage.clearDemoData();

  DrillingStorage.mergeRemote({
    boreholes: [borehole()],
    pipeRecords: [pipe()],
    events: [],
    shiftLogs: [],
    deletedIds: [],
  });
  assert.equal(DrillingStorage.getPipeRecords(BH_A).length, 1);

  DrillingStorage.mergeRemote({
    boreholes: [],
    pipeRecords: [],
    events: [],
    shiftLogs: [],
    deletedIds: [PIPE_A],
  });
  assert.equal(DrillingStorage.getPipeRecords(BH_A).length, 0);
});

test('merging does not queue the downloaded rows straight back up', () => {
  harness();
  DrillingStorage.clearDemoData();
  getOutbox().clear();

  DrillingStorage.mergeRemote({
    boreholes: [borehole()],
    pipeRecords: [pipe()],
    events: [],
    shiftLogs: [],
    deletedIds: [],
  });

  // An echo here would mean every pull re-uploads everything it just received.
  assert.equal(DrillingStorage.getUnsyncedCount(), 0);
});
