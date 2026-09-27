import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCorrection, correctionOf, correctionToRow } from './pipeCorrection';
import type { PipeRecord } from '../types';

const pipe: PipeRecord = {
  id: 'bbbbbbbb-0000-0000-0000-000000000001',
  boreholeId: 'aaaaaaaa-0000-0000-0000-000000000001',
  pipeNumber: 4,
  startDepth: 13.65,
  endDepth: 18.2,
  pipeLength: 4.55,
  startTime: '2026-09-28T08:00:00.000Z',
  endTime: '2026-09-28T08:40:00.000Z',
  durationSeconds: 2400,
  penetrationRate: 6.83,
  formation: 'Weathered Basalt',
  waterStrike: false,
  airPressure: 250,
  compressorPressure: 220,
  bitType: 'DTH Hammer - Button Bit',
  bitDiameter: 8.5,
  operator: 'Ann Njeri',
  gpsCoordinates: { lat: 0, lng: 0 },
  remarks: '',
  synced: false,
};

test('a correction carries exactly the End Pipe fields', () => {
  assert.deepEqual(Object.keys(correctionOf(pipe)).sort(), [
    'airPressure', 'bitDiameter', 'bitType', 'compressorPressure',
    'formation', 'remarks', 'waterStrike', 'waterStrikeDetails',
  ]);
});

test('applying a correction changes those fields and nothing measured', () => {
  const fixed = applyCorrection(
    pipe,
    { ...correctionOf(pipe), formation: 'Fresh Basalt / Dolerite', bitType: 'Tricone Roller Bit', remarks: 'Hard band at 16m' },
    '2026-09-28T12:00:00.000Z'
  );
  assert.equal(fixed.formation, 'Fresh Basalt / Dolerite');
  assert.equal(fixed.bitType, 'Tricone Roller Bit');
  assert.equal(fixed.remarks, 'Hard band at 16m');
  assert.equal(fixed.editedAt, '2026-09-28T12:00:00.000Z');
  for (const k of ['id', 'startDepth', 'endDepth', 'startTime', 'endTime', 'durationSeconds', 'penetrationRate', 'operator'] as const) {
    assert.deepEqual(fixed[k], pipe[k], k);
  }
});

test('a water strike added later is placed at the bottom of the pipe', () => {
  const fixed = applyCorrection(
    pipe,
    { ...correctionOf(pipe), waterStrike: true, waterStrikeDetails: { depth: 0, flowRateLpm: 90, staticWaterLevel: 12 } },
    '2026-09-28T12:00:00.000Z'
  );
  assert.equal(fixed.waterStrikeDetails?.depth, 18.2);
  assert.equal(fixed.waterStrikeDetails?.flowRateLpm, 90);
});

test('turning a water strike off drops its details', () => {
  const struck = { ...pipe, waterStrike: true, waterStrikeDetails: { depth: 18.2, flowRateLpm: 90 } };
  const fixed = applyCorrection(struck, { ...correctionOf(struck), waterStrike: false }, '2026-09-28T12:00:00.000Z');
  assert.equal(fixed.waterStrikeDetails, undefined);
});

test('remarks are saved as typed, trimmed', () => {
  const fixed = applyCorrection(pipe, { ...correctionOf(pipe), remarks: '  lost circulation at 17m  ' }, '2026-09-28T12:00:00.000Z');
  assert.equal(fixed.remarks, 'lost circulation at 17m');
});

test('the office sends only the correctable columns', () => {
  // The database refuses a reviewer's change to anything else; sending only
  // these keeps a stale dashboard from even trying.
  const row = correctionToRow(correctionOf(pipe));
  assert.deepEqual(Object.keys(row).sort(), [
    'air_pressure', 'bit_diameter', 'bit_type', 'compressor_pressure',
    'formation', 'remarks', 'water_strike', 'water_strike_details',
  ]);
});
