/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Translation between the app's camelCase records and the database's
 * snake_case rows.
 *
 * Two fields are deliberately local-only and never cross this boundary:
 * `isDemo` (seed data that must not be pushed) and `synced` (superseded by the
 * outbox). Everything else round-trips, because a field the mapper forgets is
 * a measurement the driller took and the administrator never sees.
 */

import type {
  Borehole,
  DrillingEvent,
  EventType,
  GPSCoordinates,
  PipePause,
  PipeRecord,
  ShiftLog,
  WaterStrikeDetails,
} from '../types';

export type BoreholeRow = {
  id: string;
  name: string;
  project: string | null;
  client: string | null;
  rig_name: string | null;
  target_depth: number | null;
  current_depth: number | null;
  default_pipe_length: number | null;
  bit_diameter: number | null;
  bit_type: string | null;
  gps: GPSCoordinates | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  engine_hours_start: number | null;
  compressor_hours_start: number | null;
  current_engine_hours: number | null;
  current_compressor_hours: number | null;
  casing_installed_depth: number | null;
  created_by: string;
  recorded_at: string;
  deleted_at?: string | null;
};

export type PipeRecordRow = {
  id: string;
  borehole_id: string;
  pipe_number: number;
  start_depth: number | null;
  end_depth: number | null;
  pipe_length: number | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  paused_seconds: number | null;
  pauses: PipePause[] | null;
  penetration_rate: number | null;
  formation: string | null;
  water_strike: boolean;
  water_strike_details: WaterStrikeDetails | null;
  air_pressure: number | null;
  compressor_pressure: number | null;
  bit_type: string | null;
  bit_diameter: number | null;
  operator: string | null;
  remarks: string | null;
  gps: GPSCoordinates | null;
  photo_path: string | null;
  created_by: string;
  recorded_at: string;
  deleted_at?: string | null;
};

export type DrillingEventRow = {
  id: string;
  borehole_id: string;
  type: string | null;
  title: string | null;
  occurred_at: string | null;
  depth_at_event: number | null;
  duration_minutes: number | null;
  is_npt: boolean;
  operator: string | null;
  details: DrillingEvent['details'] | null;
  photo_path: string | null;
  created_by: string;
  recorded_at: string;
  deleted_at?: string | null;
};

export type ShiftLogRow = {
  id: string;
  borehole_id: string;
  shift_date: string | null;
  shift_name: string | null;
  driller_name: string | null;
  supervisor_name: string | null;
  start_depth: number | null;
  end_depth: number | null;
  meters_drilled_today: number | null;
  productive_hours: number | null;
  non_productive_hours: number | null;
  fuel_used_liters: number | null;
  notes: string | null;
  created_by: string;
  recorded_at: string;
  deleted_at?: string | null;
};

/** Drop keys whose value is undefined so absent stays absent. */
function omitUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as T;
}

function orUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

// ---------------------------------------------------------------------------
// Boreholes
// ---------------------------------------------------------------------------

export function boreholeToRow(borehole: Borehole, userId: string): BoreholeRow {
  return {
    id: borehole.id,
    name: borehole.name,
    project: borehole.project,
    client: borehole.client,
    rig_name: borehole.rigName,
    target_depth: borehole.targetDepth,
    current_depth: borehole.currentDepth,
    default_pipe_length: borehole.defaultPipeLength,
    bit_diameter: borehole.bitDiameter,
    bit_type: borehole.bitType,
    gps: borehole.gpsCoordinates,
    status: borehole.status,
    created_at: borehole.createdAt,
    updated_at: borehole.updatedAt,
    engine_hours_start: borehole.engineHoursStart,
    compressor_hours_start: borehole.compressorHoursStart,
    current_engine_hours: borehole.currentEngineHours,
    current_compressor_hours: borehole.currentCompressorHours,
    casing_installed_depth: borehole.casingInstalledDepth ?? null,
    created_by: userId,
    // The most recent moment the device knew about this borehole.
    recorded_at: borehole.updatedAt,
  };
}

export function rowToBorehole(row: BoreholeRow): Borehole {
  return omitUndefined({
    id: row.id,
    name: row.name,
    project: row.project ?? '',
    client: row.client ?? '',
    rigName: row.rig_name ?? '',
    targetDepth: row.target_depth ?? 0,
    currentDepth: row.current_depth ?? 0,
    defaultPipeLength: row.default_pipe_length ?? 0,
    bitDiameter: row.bit_diameter ?? 0,
    bitType: row.bit_type ?? '',
    gpsCoordinates: row.gps ?? { lat: 0, lng: 0 },
    status: (row.status ?? 'active') as Borehole['status'],
    createdAt: row.created_at ?? row.recorded_at,
    updatedAt: row.updated_at ?? row.recorded_at,
    engineHoursStart: row.engine_hours_start ?? 0,
    compressorHoursStart: row.compressor_hours_start ?? 0,
    currentEngineHours: row.current_engine_hours ?? 0,
    currentCompressorHours: row.current_compressor_hours ?? 0,
    casingInstalledDepth: orUndefined(row.casing_installed_depth),
  }) as Borehole;
}

// ---------------------------------------------------------------------------
// Pipe records
// ---------------------------------------------------------------------------

export function pipeToRow(record: PipeRecord, userId: string): PipeRecordRow {
  return {
    id: record.id,
    borehole_id: record.boreholeId,
    pipe_number: record.pipeNumber,
    start_depth: record.startDepth,
    end_depth: record.endDepth,
    pipe_length: record.pipeLength,
    start_time: record.startTime,
    end_time: record.endTime,
    duration_seconds: record.durationSeconds,
    // 0, not null: null is reserved for rows from builds that predate pausing.
    paused_seconds: record.pausedSeconds ?? 0,
    pauses: record.pauses ?? null,
    penetration_rate: record.penetrationRate,
    formation: record.formation,
    water_strike: record.waterStrike,
    water_strike_details: record.waterStrikeDetails ?? null,
    air_pressure: record.airPressure,
    compressor_pressure: record.compressorPressure,
    bit_type: record.bitType,
    bit_diameter: record.bitDiameter,
    operator: record.operator,
    remarks: record.remarks,
    gps: record.gpsCoordinates ?? null,
    photo_path: record.photoUrl ?? null,
    created_by: userId,
    // When the pipe actually finished, not when it happened to upload.
    recorded_at: record.endTime,
  };
}

export function rowToPipe(row: PipeRecordRow): PipeRecord {
  return omitUndefined({
    id: row.id,
    boreholeId: row.borehole_id,
    pipeNumber: row.pipe_number,
    startDepth: row.start_depth ?? 0,
    endDepth: row.end_depth ?? 0,
    pipeLength: row.pipe_length ?? 0,
    startTime: row.start_time ?? row.recorded_at,
    endTime: row.end_time ?? row.recorded_at,
    durationSeconds: row.duration_seconds ?? 0,
    pausedSeconds: orUndefined(row.paused_seconds),
    pauses: orUndefined(row.pauses),
    penetrationRate: row.penetration_rate ?? 0,
    formation: row.formation ?? '',
    waterStrike: row.water_strike,
    waterStrikeDetails: orUndefined(row.water_strike_details),
    airPressure: row.air_pressure ?? 0,
    compressorPressure: row.compressor_pressure ?? 0,
    bitType: row.bit_type ?? '',
    bitDiameter: row.bit_diameter ?? 0,
    operator: row.operator ?? '',
    gpsCoordinates: row.gps ?? { lat: 0, lng: 0 },
    remarks: row.remarks ?? '',
    photoUrl: orUndefined(row.photo_path),
    synced: true,
  }) as PipeRecord;
}

// ---------------------------------------------------------------------------
// Drilling events
// ---------------------------------------------------------------------------

export function eventToRow(event: DrillingEvent, userId: string): DrillingEventRow {
  return {
    id: event.id,
    borehole_id: event.boreholeId,
    type: event.type,
    title: event.title,
    occurred_at: event.timestamp,
    depth_at_event: event.depthAtEvent,
    duration_minutes: event.durationMinutes ?? null,
    is_npt: event.isNPT,
    operator: event.operator,
    details: event.details ?? null,
    photo_path: event.details?.photoUrl ?? null,
    created_by: userId,
    recorded_at: event.timestamp,
  };
}

export function rowToEvent(row: DrillingEventRow): DrillingEvent {
  return omitUndefined({
    id: row.id,
    boreholeId: row.borehole_id,
    type: (row.type ?? 'General Note') as EventType,
    title: row.title ?? '',
    timestamp: row.occurred_at ?? row.recorded_at,
    durationMinutes: orUndefined(row.duration_minutes),
    isNPT: row.is_npt,
    operator: row.operator ?? '',
    depthAtEvent: row.depth_at_event ?? 0,
    details: row.details ?? {},
    synced: true,
  }) as DrillingEvent;
}

// ---------------------------------------------------------------------------
// Shift logs
// ---------------------------------------------------------------------------

export function shiftLogToRow(log: ShiftLog, userId: string): ShiftLogRow {
  return {
    id: log.id,
    borehole_id: log.boreholeId,
    shift_date: log.date,
    shift_name: log.shiftName,
    driller_name: log.drillerName,
    supervisor_name: log.supervisorName,
    start_depth: log.startDepth,
    end_depth: log.endDepth,
    meters_drilled_today: log.metersDrilledToday,
    productive_hours: log.productiveHours,
    non_productive_hours: log.nonProductiveHours,
    fuel_used_liters: log.fuelUsedLiters,
    notes: log.notes,
    created_by: userId,
    // A shift log's meaningful moment is the shift date itself.
    recorded_at: new Date(`${log.date}T00:00:00.000Z`).toISOString(),
  };
}

export function rowToShiftLog(row: ShiftLogRow): ShiftLog {
  return omitUndefined({
    id: row.id,
    boreholeId: row.borehole_id,
    date: row.shift_date ?? row.recorded_at.slice(0, 10),
    shiftName: row.shift_name ?? '',
    drillerName: row.driller_name ?? '',
    supervisorName: row.supervisor_name ?? '',
    startDepth: row.start_depth ?? 0,
    endDepth: row.end_depth ?? 0,
    metersDrilledToday: row.meters_drilled_today ?? 0,
    productiveHours: row.productive_hours ?? 0,
    nonProductiveHours: row.non_productive_hours ?? 0,
    fuelUsedLiters: row.fuel_used_liters ?? 0,
    notes: row.notes ?? '',
  }) as ShiftLog;
}
