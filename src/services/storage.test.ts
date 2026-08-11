import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DrillingStorage } from './storage';
import type { Borehole, PipeRecord, DrillingEvent } from '../types';

function createStorageHarness() {
  const store = new Map<string, string>();
  const localStorageMock = {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
  };

  (globalThis as typeof globalThis & { localStorage: typeof localStorageMock }).localStorage = localStorageMock;
  return localStorageMock;
}

test('saves and activates a new borehole without losing selection state', () => {
  createStorageHarness();
  const storage = new DrillingStorage();
  const borehole: Borehole = {
    id: 'bh-test-1',
    name: 'BH-TEST-1',
    project: 'Test Project',
    client: 'Test Client',
    rigName: 'Rig #4',
    targetDepth: 120,
    currentDepth: 0,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer - Button Bit',
    gpsCoordinates: { lat: 0, lng: 0 },
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engineHoursStart: 100,
    compressorHoursStart: 80,
    currentEngineHours: 100,
    currentCompressorHours: 80,
    casingInstalledDepth: 0,
  };

  storage.saveBorehole(borehole);
  storage.setActiveBorehole(borehole.id);

  const saved = storage.getBoreholes();
  assert.equal(saved[0].id, 'bh-test-1');
  assert.equal(saved.length, 3);
  assert.equal(storage.getActiveBorehole().id, borehole.id);
});

test('persists pipe records and removes only the requested record', () => {
  createStorageHarness();
  const storage = new DrillingStorage();
  const first: PipeRecord = {
    id: 'pipe-test-1',
    boreholeId: 'bh-2026-04',
    pipeNumber: 99,
    startDepth: 80,
    endDepth: 84.55,
    pipeLength: 4.55,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    durationSeconds: 3600,
    penetrationRate: 5,
    formation: 'Weathered Basalt',
    waterStrike: false,
    airPressure: 240,
    compressorPressure: 210,
    bitType: 'DTH Hammer - Button Bit',
    bitDiameter: 8.5,
    operator: 'James',
    gpsCoordinates: { lat: 0, lng: 0 },
    remarks: 'Test pipe',
    synced: false,
  };
  const second: PipeRecord = {
    ...first,
    id: 'pipe-test-2',
    pipeNumber: 100,
  };

  storage.savePipeRecord(first);
  storage.savePipeRecord(second);

  const beforeDelete = storage.getPipeRecords('bh-2026-04');
  assert.equal(beforeDelete.length, 21);
  assert.ok(beforeDelete.some((item) => item.id === 'pipe-test-1'));

  storage.deletePipeRecord('bh-2026-04', 'pipe-test-1');
  const afterDelete = storage.getPipeRecords('bh-2026-04');

  assert.equal(afterDelete.length, 20);
  assert.ok(afterDelete.some((item) => item.id === 'pipe-test-2'));
  assert.equal(afterDelete.some((item) => item.id === 'pipe-test-1'), false);
});

test('appends consecutive pipe records that arrive without an id', () => {
  createStorageHarness();
  const storage = new DrillingStorage();
  const before = storage.getPipeRecords('bh-2026-04').length;

  // The END PIPE modal emits Omit<PipeRecord, 'id'>; nothing upstream assigns one.
  const draft = (pipeNumber: number): PipeRecord =>
    ({
      boreholeId: 'bh-2026-04',
      pipeNumber,
      startDepth: 86.45,
      endDepth: 91.0,
      pipeLength: 4.55,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationSeconds: 1800,
      penetrationRate: 9.1,
      formation: 'Fresh Basalt / Dolerite',
      waterStrike: false,
      airPressure: 250,
      compressorPressure: 220,
      bitType: 'DTH Hammer - Button Bit',
      bitDiameter: 8.5,
      operator: 'James Wanjala',
      gpsCoordinates: { lat: 0, lng: 0 },
      remarks: '',
      synced: false,
    }) as PipeRecord;

  storage.savePipeRecord(draft(20));
  storage.savePipeRecord(draft(21));
  storage.savePipeRecord(draft(22));

  const saved = storage.getPipeRecords('bh-2026-04');
  assert.equal(saved.length, before + 3, 'each END PIPE save must append a new record');
  assert.deepEqual(
    saved.slice(-3).map((r) => r.pipeNumber),
    [20, 21, 22]
  );

  const generatedIds = saved.slice(-3).map((r) => r.id);
  assert.equal(generatedIds.every((id) => typeof id === 'string' && id.length > 0), true);
  assert.equal(new Set(generatedIds).size, 3, 'generated ids must be unique');
});

test('appends consecutive events that arrive without an id', () => {
  createStorageHarness();
  const storage = new DrillingStorage();
  const before = storage.getEvents('bh-2026-04').length;

  const draft = (title: string): DrillingEvent =>
    ({
      boreholeId: 'bh-2026-04',
      type: 'Breakdown',
      title,
      timestamp: new Date().toISOString(),
      durationMinutes: 20,
      isNPT: true,
      operator: 'James Wanjala',
      depthAtEvent: 86.45,
      details: {},
      synced: false,
    }) as DrillingEvent;

  storage.saveEvent(draft('First breakdown'));
  storage.saveEvent(draft('Second breakdown'));

  const saved = storage.getEvents('bh-2026-04');
  assert.equal(saved.length, before + 2, 'each event save must append a new event');
  assert.ok(saved.some((e) => e.title === 'First breakdown'));
  assert.ok(saved.some((e) => e.title === 'Second breakdown'));

  const generatedIds = saved.filter((e) => e.title.endsWith('breakdown')).map((e) => e.id);
  assert.equal(new Set(generatedIds).size, 2, 'generated ids must be unique');
});

test('backfills ids on records already persisted without one', () => {
  const store = createStorageHarness();
  const storage = new DrillingStorage();

  // Seed the store the way the id-less save path used to leave it.
  const seededPipes = storage.getPipeRecords();
  const seededEvents = storage.getEvents();
  store.setItem(
    'wwdm_pipe_records',
    JSON.stringify([...seededPipes, { boreholeId: 'bh-2026-04', pipeNumber: 20, pipeLength: 4.55 }])
  );
  store.setItem(
    'wwdm_events',
    JSON.stringify([...seededEvents, { boreholeId: 'bh-2026-04', type: 'Breakdown', title: 'Legacy' }])
  );

  const pipes = storage.getPipeRecords('bh-2026-04');
  const events = storage.getEvents('bh-2026-04');

  const legacyPipe = pipes.find((r) => r.pipeNumber === 20);
  const legacyEvent = events.find((e) => e.title === 'Legacy');
  assert.ok(legacyPipe?.id, 'legacy pipe record should be given an id');
  assert.ok(legacyEvent?.id, 'legacy event should be given an id');
  assert.equal(new Set(pipes.map((r) => r.id)).size, pipes.length, 'pipe ids must stay unique');

  // Backfilled ids must be persisted, otherwise deletes would target a stale id.
  const reread = storage.getPipeRecords('bh-2026-04').find((r) => r.pipeNumber === 20);
  assert.equal(reread?.id, legacyPipe?.id);

  // And the healed record is now individually deletable.
  storage.deletePipeRecord('bh-2026-04', legacyPipe!.id);
  assert.equal(
    storage.getPipeRecords('bh-2026-04').some((r) => r.pipeNumber === 20),
    false
  );
});

test('ignores delete calls that carry no record id', () => {
  createStorageHarness();
  const storage = new DrillingStorage();
  const pipesBefore = storage.getPipeRecords('bh-2026-04').length;
  const eventsBefore = storage.getEvents('bh-2026-04').length;

  storage.deletePipeRecord('bh-2026-04', undefined as unknown as string);
  storage.deleteEvent('bh-2026-04', undefined as unknown as string);

  assert.equal(storage.getPipeRecords('bh-2026-04').length, pipesBefore);
  assert.equal(storage.getEvents('bh-2026-04').length, eventsBefore);
});

test('persists events and removes only the requested event', () => {
  createStorageHarness();
  const storage = new DrillingStorage();
  const event: DrillingEvent = {
    id: 'event-test-1',
    boreholeId: 'bh-2026-04',
    type: 'Breakdown',
    title: 'Test breakdown',
    timestamp: new Date().toISOString(),
    durationMinutes: 15,
    isNPT: true,
    operator: 'James',
    depthAtEvent: 45,
    details: { notes: 'test' },
    synced: false,
  };
  const secondEvent: DrillingEvent = {
    ...event,
    id: 'event-test-2',
    title: 'Second test event',
  };

  storage.saveEvent(event);
  storage.saveEvent(secondEvent);

  const beforeDelete = storage.getEvents('bh-2026-04');
  assert.ok(beforeDelete.some((item) => item.id === 'event-test-1'));
  assert.ok(beforeDelete.some((item) => item.id === 'event-test-2'));

  storage.deleteEvent('bh-2026-04', 'event-test-1');
  const afterDelete = storage.getEvents('bh-2026-04');

  assert.equal(afterDelete.length, 5);
  assert.ok(afterDelete.some((item) => item.id === 'event-test-2'));
  assert.equal(afterDelete.some((item) => item.id === 'event-test-1'), false);
});

test('manages users and falls back to the next active profile when deleting the current one', () => {
  createStorageHarness();
  const storage = new DrillingStorage();
  const seededUsers = storage.getUsers();

  storage.saveUser({
    id: 'usr-test-1',
    name: 'Test Driller',
    role: 'Driller',
    badgeNumber: 'DRL-001',
  });
  storage.saveUser({
    id: 'usr-test-2',
    name: 'Test Supervisor',
    role: 'Supervisor',
    badgeNumber: 'SUP-001',
  });

  storage.setCurrentUser('usr-test-2');
  assert.equal(storage.getCurrentUser().id, 'usr-test-2');

  storage.deleteUser('usr-test-2');

  const remainingUsers = storage.getUsers();
  assert.equal(remainingUsers.length, seededUsers.length + 1);
  assert.equal(remainingUsers.some((user) => user.id === 'usr-test-2'), false);
  assert.equal(remainingUsers[0].id, 'usr-test-1');
  assert.equal(storage.getCurrentUser().id, 'usr-test-1');
});

test('keeps the running pipe timer scoped to its own borehole', () => {
  createStorageHarness();
  const storage = new DrillingStorage();

  storage.saveActiveTimer({
    boreholeId: 'bh-2026-04',
    isActive: true,
    pipeNumber: 20,
    startDepth: 86.45,
    startTime: new Date().toISOString(),
    formation: 'Fresh Basalt / Dolerite',
    operator: 'James Wanjala',
  });

  // Switching to another project must not surface the first project's timer,
  // or END PIPE would file that pipe against the wrong borehole.
  const otherTimer = storage.getActiveTimer('bh-2026-02');
  assert.equal(otherTimer.isActive, false);
  assert.notEqual(otherTimer.startDepth, 86.45);

  // Switching back restores the still-running timer intact.
  const original = storage.getActiveTimer('bh-2026-04');
  assert.equal(original.isActive, true);
  assert.equal(original.pipeNumber, 20);
  assert.equal(original.startDepth, 86.45);

  // Timers are independent per borehole.
  storage.saveActiveTimer({
    boreholeId: 'bh-2026-02',
    isActive: true,
    pipeNumber: 5,
    startDepth: 20,
    startTime: new Date().toISOString(),
    formation: 'Soft Clay',
  });
  assert.equal(storage.getActiveTimer('bh-2026-04').pipeNumber, 20);
  assert.equal(storage.getActiveTimer('bh-2026-02').pipeNumber, 5);

  storage.clearActiveTimer('bh-2026-02');
  assert.equal(storage.getActiveTimer('bh-2026-02').isActive, false);
  assert.equal(storage.getActiveTimer('bh-2026-04').isActive, true);
});

test('migrates a legacy single-timer payload to the active borehole', () => {
  const store = createStorageHarness();
  const storage = new DrillingStorage();

  store.setItem(
    'wwdm_active_timer',
    JSON.stringify({
      boreholeId: 'bh-2026-04',
      isActive: true,
      pipeNumber: 20,
      startDepth: 86.45,
      startTime: new Date().toISOString(),
      formation: 'Fresh Basalt / Dolerite',
    })
  );

  assert.equal(storage.getActiveTimer('bh-2026-04').isActive, true);
  assert.equal(storage.getActiveTimer('bh-2026-04').pipeNumber, 20);
  assert.equal(storage.getActiveTimer('bh-2026-02').isActive, false);
});

test('deletes a borehole project and its related records', () => {
  createStorageHarness();
  const storage = new DrillingStorage();

  storage.saveBorehole({
    id: 'bh-delete-me',
    name: 'Delete Me',
    project: 'Delete Project',
    client: 'Test Client',
    rigName: 'Rig #1',
    targetDepth: 100,
    currentDepth: 0,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer - Button Bit',
    gpsCoordinates: { lat: 0, lng: 0 },
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engineHoursStart: 10,
    compressorHoursStart: 8,
    currentEngineHours: 10,
    currentCompressorHours: 8,
    casingInstalledDepth: 0,
  });

  storage.savePipeRecord({
    id: 'pipe-delete-me',
    boreholeId: 'bh-delete-me',
    pipeNumber: 1,
    startDepth: 0,
    endDepth: 4.55,
    pipeLength: 4.55,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    durationSeconds: 3600,
    penetrationRate: 5,
    formation: 'Weathered Basalt',
    waterStrike: false,
    airPressure: 240,
    compressorPressure: 210,
    bitType: 'DTH Hammer - Button Bit',
    bitDiameter: 8.5,
    operator: 'James',
    gpsCoordinates: { lat: 0, lng: 0 },
    remarks: 'Test',
    synced: false,
  });

  storage.saveEvent({
    id: 'event-delete-me',
    boreholeId: 'bh-delete-me',
    type: 'Breakdown',
    title: 'Test delete',
    timestamp: new Date().toISOString(),
    durationMinutes: 10,
    isNPT: true,
    operator: 'James',
    depthAtEvent: 4.55,
    details: { notes: 'delete me' },
    synced: false,
  });

  storage.deleteBorehole('bh-delete-me');

  const remainingBoreholes = storage.getBoreholes();
  assert.equal(remainingBoreholes.some((bh) => bh.id === 'bh-delete-me'), false);
  assert.equal(storage.getPipeRecords('bh-delete-me').length, 0);
  assert.equal(storage.getEvents('bh-delete-me').length, 0);
});

// --- deleting a pipe must roll the borehole depth back ----------------------
// A deleted pipe left `currentDepth` at the deleted pipe's end depth, so the
// next pipe started below the bottom of the hole and the log gained a gap of
// undrilled metres it then billed for.

function depthHarness() {
  createStorageHarness();
  const storage = new DrillingStorage();
  storage.saveBorehole({
    id: 'bh-depth',
    name: 'BH-DEPTH',
    project: 'Depth Project',
    client: 'Test Client',
    rigName: 'Rig #1',
    targetDepth: 100,
    currentDepth: 0,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer - Button Bit',
    gpsCoordinates: { lat: 0, lng: 0 },
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engineHoursStart: 10,
    compressorHoursStart: 8,
    currentEngineHours: 10,
    currentCompressorHours: 8,
    casingInstalledDepth: 0,
  });
  const addPipe = (id: string, n: number, start: number, end: number, boreholeId = 'bh-depth') =>
    storage.savePipeRecord({
      id,
      boreholeId,
      pipeNumber: n,
      startDepth: start,
      endDepth: end,
      pipeLength: Number((end - start).toFixed(2)),
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationSeconds: 3600,
      penetrationRate: 5,
      formation: 'Weathered Basalt',
      waterStrike: false,
      airPressure: 240,
      compressorPressure: 210,
      bitType: 'DTH Hammer - Button Bit',
      bitDiameter: 8.5,
      operator: 'James',
      gpsCoordinates: { lat: 0, lng: 0 },
      remarks: 'Test',
      synced: false,
    });
  const depthOf = (id = 'bh-depth') =>
    storage.getBoreholes().find((b) => b.id === id)!.currentDepth;
  return { storage, addPipe, depthOf };
}

test('deleting the deepest pipe rolls the borehole back to the pipe below it', () => {
  const { storage, addPipe, depthOf } = depthHarness();
  addPipe('p1', 1, 0, 4.55);
  addPipe('p2', 2, 4.55, 9.1);
  addPipe('p3', 3, 9.1, 13.65);
  assert.equal(depthOf(), 13.65);

  storage.deletePipeRecord('p3');

  assert.equal(depthOf(), 9.1);
});

test('deleting the last remaining pipe returns the borehole to zero', () => {
  const { storage, addPipe, depthOf } = depthHarness();
  addPipe('p1', 1, 0, 4.55);

  storage.deletePipeRecord('p1');

  assert.equal(depthOf(), 0);
});

test('deleting a shallower pipe leaves the measured depth alone', () => {
  const { storage, addPipe, depthOf } = depthHarness();
  addPipe('p1', 1, 0, 4.55);
  addPipe('p2', 2, 4.55, 9.1);

  storage.deletePipeRecord('p1');

  assert.equal(depthOf(), 9.1);
});

test('deleting a pipe does not disturb another borehole depth', () => {
  const { storage, addPipe, depthOf } = depthHarness();
  storage.saveBorehole({
    id: 'bh-other',
    name: 'BH-OTHER',
    project: 'Other',
    client: 'Test Client',
    rigName: 'Rig #2',
    targetDepth: 100,
    currentDepth: 0,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer - Button Bit',
    gpsCoordinates: { lat: 0, lng: 0 },
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engineHoursStart: 10,
    compressorHoursStart: 8,
    currentEngineHours: 10,
    currentCompressorHours: 8,
    casingInstalledDepth: 0,
  });
  addPipe('p1', 1, 0, 4.55);
  addPipe('o1', 1, 0, 20, 'bh-other');

  storage.deletePipeRecord('p1');

  assert.equal(depthOf('bh-other'), 20);
});

test('the corrected depth is queued so the server does not keep the deleted pipe depth', () => {
  // Real uuids: the outbox refuses to queue anything else, so the shorthand ids
  // the tests above use would leave the queue empty and prove nothing.
  const bhId = randomUUID();
  const p1 = randomUUID();
  const p2 = randomUUID();
  createStorageHarness();
  const storage = new DrillingStorage();
  storage.saveBorehole({
    id: bhId,
    name: 'BH-QUEUE',
    project: 'Queue Project',
    client: 'Test Client',
    rigName: 'Rig #1',
    targetDepth: 100,
    currentDepth: 0,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer - Button Bit',
    gpsCoordinates: { lat: 0, lng: 0 },
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engineHoursStart: 10,
    compressorHoursStart: 8,
    currentEngineHours: 10,
    currentCompressorHours: 8,
    casingInstalledDepth: 0,
  });
  const add = (id: string, n: number, start: number, end: number) =>
    storage.savePipeRecord({
      id,
      boreholeId: bhId,
      pipeNumber: n,
      startDepth: start,
      endDepth: end,
      pipeLength: Number((end - start).toFixed(2)),
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      durationSeconds: 3600,
      penetrationRate: 5,
      formation: 'Weathered Basalt',
      waterStrike: false,
      airPressure: 240,
      compressorPressure: 210,
      bitType: 'DTH Hammer - Button Bit',
      bitDiameter: 8.5,
      operator: 'James',
      gpsCoordinates: { lat: 0, lng: 0 },
      remarks: 'Test',
      synced: false,
    });
  add(p1, 1, 0, 4.55);
  add(p2, 2, 4.55, 9.1);

  storage.deletePipeRecord(p2);

  // Upserts collapse into one queue slot per record, so assert on the pending
  // borehole payload rather than expecting a freshly appended entry.
  const queue = JSON.parse(localStorage.getItem('wwdm_outbox') ?? '[]');
  const pending = queue.find(
    (o: { entity: string; op: string; entityId: string }) =>
      o.entity === 'borehole' && o.op === 'upsert' && o.entityId === bhId
  );
  assert.ok(pending, 'expected a pending borehole upsert carrying the new depth');
  assert.equal(pending.payload.currentDepth, 4.55);
});
