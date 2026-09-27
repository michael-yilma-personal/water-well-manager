/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PipeRecord } from '../types';
import type { PipeRecordRow } from './mappers';

/**
 * Correcting a saved pipe record.
 *
 * Only what the crew enters on the End Pipe sheet can be corrected afterwards:
 * formation, bit, pressures, water strike and remarks. Depths and times are
 * measured by the app and back client billing, so they stay as recorded. The
 * database enforces the same list for anyone who is not the author
 * (20260928000000_review_pipe_corrections.sql).
 */
export type PipeCorrection = Pick<
  PipeRecord,
  | 'formation'
  | 'bitType'
  | 'bitDiameter'
  | 'airPressure'
  | 'compressorPressure'
  | 'waterStrike'
  | 'waterStrikeDetails'
  | 'remarks'
>;

export function correctionOf(record: PipeRecord): PipeCorrection {
  return {
    formation: record.formation,
    bitType: record.bitType,
    bitDiameter: record.bitDiameter,
    airPressure: record.airPressure,
    compressorPressure: record.compressorPressure,
    waterStrike: record.waterStrike,
    waterStrikeDetails: record.waterStrikeDetails,
    remarks: record.remarks,
  };
}

/** Tidy a correction the way the End Pipe sheet tidies a new record. */
function normalise(record: PipeRecord, c: PipeCorrection): PipeCorrection {
  return {
    ...c,
    remarks: (c.remarks ?? '').trim(),
    // A strike found on review happened somewhere in this pipe; the bottom of
    // it is where End Pipe would have put it.
    waterStrikeDetails: c.waterStrike
      ? { ...(c.waterStrikeDetails ?? { flowRateLpm: 0 }), depth: record.endDepth }
      : undefined,
  };
}

export function applyCorrection(
  record: PipeRecord,
  correction: PipeCorrection,
  nowIso: string
): PipeRecord {
  return { ...record, ...normalise(record, correction), editedAt: nowIso };
}

export function correctionToRow(
  c: PipeCorrection
): Pick<
  PipeRecordRow,
  | 'formation'
  | 'bit_type'
  | 'bit_diameter'
  | 'air_pressure'
  | 'compressor_pressure'
  | 'water_strike'
  | 'water_strike_details'
  | 'remarks'
> {
  return {
    formation: c.formation,
    bit_type: c.bitType,
    bit_diameter: c.bitDiameter,
    air_pressure: c.airPressure,
    compressor_pressure: c.compressorPressure,
    water_strike: c.waterStrike,
    water_strike_details: c.waterStrikeDetails ?? null,
    remarks: c.remarks,
  };
}

/** The office's version: normalised against the record, then as columns. */
export function correctionRowFor(record: PipeRecord, c: PipeCorrection) {
  return correctionToRow(normalise(record, c));
}
