import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boreholeToRow,
  rowToBorehole,
  pipeToRow,
  rowToPipe,
  eventToRow,
  rowToEvent,
  shiftLogToRow,
  rowToShiftLog,
} from './mappers';
import type { Borehole, PipeRecord, DrillingEvent, ShiftLog } from '../types';

const UID = '11111111-2222-3333-4444-555555555555';

const borehole: Borehole = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  name: 'BH-2026-04 (Kibera Community Well #3)',
  project: 'Eastern Water Supply Project',
  client: 'Nairobi Water & Sanitation Co.',
  rigName: 'Rig #4 - Schramm T685WS',
  targetDepth: 160,
  currentDepth: 86.45,
  defaultPipeLength: 4.55,
  bitDiameter: 8.5,
  bitType: 'DTH Hammer - Button Bit',
  gpsCoordinates: { lat: -1.3142, lng: 36.7845, elevation: 1680, accuracy: 4.2, timestamp: '2026-08-01T09:00:00.000Z' },
  status: 'active',
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-05T09:00:00.000Z',
  engineHoursStart: 4120,
  compressorHoursStart: 3080.5,
  currentEngineHours: 4144.2,
  currentCompressorHours: 3101.8,
  casingInstalledDepth: 24,
};

const pipeRecord: PipeRecord = {
  id: 'bbbbbbbb-0000-0000-0000-000000000001',
  boreholeId: borehole.id,
  pipeNumber: 10,
  startDepth: 40.95,
  endDepth: 45.5,
  pipeLength: 4.55,
  startTime: '2026-08-05T08:00:00.000Z',
  endTime: '2026-08-05T08:32:00.000Z',
  durationSeconds: 1920,
  penetrationRate: 8.53,
  formation: 'Fractured Basalt (Water Bearing)',
  waterStrike: true,
  waterStrikeDetails: {
    depth: 44.5,
    flowRateLpm: 180,
    staticWaterLevel: 22,
    ec: 480,
    ph: 7.1,
    notes: 'Strong aquifer strike. Clean water.',
  },
  airPressure: 248,
  compressorPressure: 219,
  bitType: 'DTH Hammer - Button Bit',
  bitDiameter: 8.5,
  operator: 'James Wanjala',
  gpsCoordinates: { lat: -1.3142, lng: 36.7845, elevation: 1680 },
  remarks: 'Hard band at 43m',
  photoUrl: 'user/photo-1.jpg',
  synced: false,
};

const event: DrillingEvent = {
  id: 'cccccccc-0000-0000-0000-000000000001',
  boreholeId: borehole.id,
  type: 'Breakdown',
  title: 'Hydraulic hose burst',
  timestamp: '2026-08-05T11:15:00.000Z',
  durationMinutes: 45,
  isNPT: true,
  operator: 'James Wanjala',
  depthAtEvent: 91,
  details: {
    fuelLiters: 30,
    engineHours: 4144.2,
    waterStrikeLpm: 180,
    notes: 'Replaced hose, resumed after 45 min',
  },
  synced: false,
};

const shiftLog: ShiftLog = {
  id: 'dddddddd-0000-0000-0000-000000000001',
  boreholeId: borehole.id,
  date: '2026-08-05',
  shiftName: 'Day Shift (06:00 - 18:00)',
  drillerName: 'James Wanjala',
  supervisorName: 'Eng. Sarah Omondi',
  startDepth: 45.5,
  endDepth: 91,
  metersDrilledToday: 45.5,
  productiveHours: 10.6,
  nonProductiveHours: 2.2,
  fuelUsedLiters: 180,
  notes: 'Normal operations',
};

/**
 * Round-tripping is the test that matters: a field the mapper forgets is a
 * field the driller measured and the admin never sees.
 */

test('borehole survives a round trip through the row shape', () => {
  const back = rowToBorehole(boreholeToRow(borehole, UID));
  assert.deepEqual(back, borehole);
});

test('pipe record survives a round trip, including water strike detail', () => {
  const back = rowToPipe(pipeToRow(pipeRecord, UID));
  assert.deepEqual({ ...back, synced: false }, pipeRecord);
});

test('drilling event survives a round trip, including the details blob', () => {
  const back = rowToEvent(eventToRow(event, UID));
  assert.deepEqual({ ...back, synced: false }, event);
});

test('shift log survives a round trip', () => {
  const back = rowToShiftLog(shiftLogToRow(shiftLog, UID));
  assert.deepEqual(back, shiftLog);
});

test('rows are stamped with the authoring user so RLS can enforce ownership', () => {
  assert.equal(boreholeToRow(borehole, UID).created_by, UID);
  assert.equal(pipeToRow(pipeRecord, UID).created_by, UID);
  assert.equal(eventToRow(event, UID).created_by, UID);
  assert.equal(shiftLogToRow(shiftLog, UID).created_by, UID);
});

test('rows carry a device timestamp for ordering reports', () => {
  // received_at is assigned by the server; recorded_at is what the rig saw.
  assert.equal(pipeToRow(pipeRecord, UID).recorded_at, pipeRecord.endTime);
  assert.equal(eventToRow(event, UID).recorded_at, event.timestamp);
  assert.equal(boreholeToRow(borehole, UID).recorded_at, borehole.updatedAt);
});

test('demo and sync bookkeeping never reach the server', () => {
  const row = pipeToRow({ ...pipeRecord, isDemo: true }, UID) as Record<string, unknown>;
  assert.ok(!('isDemo' in row), 'isDemo is a local concept');
  assert.ok(!('synced' in row), 'synced is a local concept');
});

test('optional fields stay absent rather than becoming null noise', () => {
  const minimal: PipeRecord = { ...pipeRecord, waterStrikeDetails: undefined, photoUrl: undefined };
  const back = rowToPipe(pipeToRow(minimal, UID));
  assert.equal(back.waterStrikeDetails, undefined);
  assert.equal(back.photoUrl, undefined);
});
