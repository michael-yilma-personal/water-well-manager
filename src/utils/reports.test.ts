import assert from 'node:assert/strict';
import test from 'node:test';
import { summariseStrata } from './reports';
import type { PipeRecord } from '../types';

/**
 * Builds a pipe record with only the fields the strata summary reads. The rest
 * of PipeRecord is irrelevant here and filling it in would bury the intent.
 */
function pipe(
  n: number,
  startDepth: number,
  endDepth: number,
  formation: string,
  durationSeconds: number
): PipeRecord {
  const hours = durationSeconds / 3600;
  return {
    id: `pipe-${n}`,
    boreholeId: 'bh-1',
    pipeNumber: n,
    startDepth,
    endDepth,
    pipeLength: Number((endDepth - startDepth).toFixed(2)),
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    durationSeconds,
    penetrationRate: Number(((endDepth - startDepth) / hours).toFixed(2)),
    formation,
    waterStrike: false,
    airPressure: 250,
    compressorPressure: 220,
    bitType: 'DTH Hammer - Button Bit',
    bitDiameter: 8.5,
    operator: 'James Wanjala',
    gpsCoordinates: { lat: 0, lng: 0 },
    remarks: '',
    synced: false,
  } as PipeRecord;
}

test('consecutive pipes through one formation collapse into a single band', () => {
  const bands = summariseStrata([
    pipe(1, 0, 5, 'Weathered Basalt', 3600),
    pipe(2, 5, 10, 'Weathered Basalt', 3600),
  ]);

  assert.equal(bands.length, 1);
  assert.equal(bands[0].formation, 'Weathered Basalt');
  assert.equal(bands[0].startDepth, 0);
  assert.equal(bands[0].endDepth, 10);
  assert.equal(bands[0].thickness, 10);
  assert.equal(bands[0].pipes, 2);
});

test('re-entering a formation reports two bands, not one that swallows the layer between', () => {
  // Basalt 0-10, granite 10-40, basalt again 40-60. Grouping by formation name
  // reported basalt as a single 0-60m/60m-thick band overlapping the granite,
  // so the summary claimed 90m of strata in a 60m hole.
  const bands = summariseStrata([
    pipe(1, 0, 10, 'Fresh Basalt', 1800),
    pipe(2, 10, 40, 'Fresh Granite', 21600),
    pipe(3, 40, 60, 'Fresh Basalt', 3600),
  ]);

  assert.equal(bands.length, 3);
  assert.deepEqual(
    bands.map((b) => [b.formation, b.startDepth, b.endDepth]),
    [
      ['Fresh Basalt', 0, 10],
      ['Fresh Granite', 10, 40],
      ['Fresh Basalt', 40, 60],
    ]
  );
  // The whole point: thicknesses tile the hole exactly once.
  assert.equal(
    bands.reduce((s, b) => s + b.thickness, 0),
    60
  );
});

test('average speed is weighted by time, so one fast thin pipe cannot inflate it', () => {
  // 90m in 9h (10 m/hr) and 1m in 0.01h (100 m/hr).
  // Unweighted mean of rates = 55 m/hr. Time-weighted truth = 91m / 9.01h ≈ 10.10.
  const bands = summariseStrata([
    pipe(1, 0, 90, 'Fresh Granite', 32400),
    pipe(2, 90, 91, 'Fresh Granite', 36),
  ]);

  assert.equal(bands.length, 1);
  assert.equal(Number(bands[0].avgRate.toFixed(2)), 10.1);
});

test('records arriving out of order are banded by depth, not by array order', () => {
  const bands = summariseStrata([
    pipe(3, 40, 60, 'Fresh Basalt', 3600),
    pipe(1, 0, 10, 'Fresh Basalt', 1800),
    pipe(2, 10, 40, 'Fresh Granite', 21600),
  ]);

  assert.deepEqual(
    bands.map((b) => [b.formation, b.startDepth, b.endDepth]),
    [
      ['Fresh Basalt', 0, 10],
      ['Fresh Granite', 10, 40],
      ['Fresh Basalt', 40, 60],
    ]
  );
});

test('a borehole with no pipes summarises to nothing rather than throwing', () => {
  assert.deepEqual(summariseStrata([]), []);
});

test('a zero-duration pipe does not produce an infinite rate', () => {
  const bands = summariseStrata([pipe(1, 0, 4.55, 'Topsoil & Alluvium', 0)]);

  assert.equal(bands.length, 1);
  assert.equal(Number.isFinite(bands[0].avgRate), true);
  assert.equal(bands[0].avgRate, 0);
});
