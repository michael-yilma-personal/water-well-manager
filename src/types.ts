export type UserRole = 'Driller' | 'Data Logger' | 'Supervisor' | 'Administrator';

export interface User {
  id: string;
  name: string;
  role: UserRole;
  avatar?: string;
  badgeNumber: string;
}

export interface GPSCoordinates {
  lat: number;
  lng: number;
  elevation?: number;
  accuracy?: number;
  timestamp?: string;
}

export interface WaterStrikeDetails {
  depth: number;
  flowRateLpm: number; // Liters per minute
  staticWaterLevel?: number;
  ec?: number; // Electrical Conductivity in uS/cm
  ph?: number;
  notes?: string;
}

export interface Borehole {
  /**
   * Seeded sample data. Identical on every install, so it must never be
   * pushed to the server - ten phones would otherwise collide on one fake
   * borehole and fill the admin dashboard with it. The outbox refuses to
   * enqueue anything carrying this flag.
   */
  isDemo?: boolean;
  id: string;
  name: string;
  project: string;
  client: string;
  rigName: string;
  targetDepth: number; // meters
  currentDepth: number; // meters
  defaultPipeLength: number; // default 4.55 meters
  bitDiameter: number; // inches
  bitType: string;
  gpsCoordinates: GPSCoordinates;
  status: 'active' | 'completed' | 'suspended';
  createdAt: string;
  updatedAt: string;
  engineHoursStart: number;
  compressorHoursStart: number;
  currentEngineHours: number;
  currentCompressorHours: number;
  casingInstalledDepth?: number;
}

export interface PipeRecord {
  /**
   * Seeded sample data. Identical on every install, so it must never be
   * pushed to the server - ten phones would otherwise collide on one fake
   * borehole and fill the admin dashboard with it. The outbox refuses to
   * enqueue anything carrying this flag.
   */
  isDemo?: boolean;
  id: string;
  boreholeId: string;
  pipeNumber: number;
  startDepth: number; // meters
  endDepth: number; // meters
  pipeLength: number; // meters
  startTime: string; // ISO string
  endTime: string; // ISO string
  /** Time the bit was actually drilling: start to end, less any pauses. */
  durationSeconds: number; // seconds
  /** Total time this pipe spent paused. Absent on pipes never paused. */
  pausedSeconds?: number;
  /** Each pause taken during this pipe, oldest first. */
  pauses?: PipePause[];
  penetrationRate: number; // m/hr
  formation: string;
  waterStrike: boolean;
  waterStrikeDetails?: WaterStrikeDetails;
  airPressure: number; // PSI
  compressorPressure: number; // PSI
  bitType: string;
  bitDiameter: number; // inches
  operator: string;
  gpsCoordinates: GPSCoordinates;
  remarks: string;
  photoUrl?: string;
  synced: boolean;
}

export type EventType =
  | 'Breakdown'
  | 'Rod Connection'
  | 'Bit Change'
  | 'Refueling'
  | 'Maintenance'
  | 'Water Strike'
  | 'Change Formation'
  | 'Take Photo'
  | 'General Note'
  | 'Drilling Paused';

export interface DrillingEvent {
  /**
   * Seeded sample data. Identical on every install, so it must never be
   * pushed to the server - ten phones would otherwise collide on one fake
   * borehole and fill the admin dashboard with it. The outbox refuses to
   * enqueue anything carrying this flag.
   */
  isDemo?: boolean;
  id: string;
  boreholeId: string;
  type: EventType;
  title: string;
  timestamp: string; // ISO string
  durationMinutes?: number;
  isNPT: boolean; // True for Non-Productive Time (e.g. Breakdown, Maintenance)
  operator: string;
  depthAtEvent: number;
  details: {
    fuelLiters?: number;
    fuelCost?: number;
    engineHours?: number;
    compressorHours?: number;
    newBitType?: string;
    newBitDiameter?: number;
    newFormation?: string;
    waterStrikeLpm?: number;
    waterStrikeDepth?: number;
    staticWaterLevel?: number;
    photoUrl?: string;
    notes?: string;
    /** Drilling Paused: which pipe, why, and when drilling picked up again. */
    pipeNumber?: number;
    pauseReason?: string;
    resumedAt?: string;
  };
  synced: boolean;
}

export interface ShiftLog {
  /**
   * Seeded sample data. Identical on every install, so it must never be
   * pushed to the server - ten phones would otherwise collide on one fake
   * borehole and fill the admin dashboard with it. The outbox refuses to
   * enqueue anything carrying this flag.
   */
  isDemo?: boolean;
  id: string;
  boreholeId: string;
  date: string; // YYYY-MM-DD
  shiftName: string; // e.g., 'Day Shift (06:00 - 18:00)'
  drillerName: string;
  supervisorName: string;
  startDepth: number;
  endDepth: number;
  metersDrilledToday: number;
  productiveHours: number;
  nonProductiveHours: number;
  fuelUsedLiters: number;
  notes: string;
}

/**
 * One stretch of a pipe where drilling stopped and the timer was held.
 * An open pause (no `end`) means the rig is paused right now.
 */
export interface PipePause {
  start: string; // ISO
  end?: string; // ISO
  reason: string;
  /** The Drilling Paused event that reports this pause to the office. */
  eventId: string;
}

export interface ActivePipeTimer {
  boreholeId?: string;
  isActive: boolean;
  pipeNumber: number;
  startDepth: number;
  startTime: string; // ISO
  pipeLength?: number; // e.g. 4.55
  formation: string;
  airPressure?: number;
  compressorPressure?: number;
  bitType?: string;
  bitDiameter?: number;
  operator?: string;
  remarks?: string;
  pauses?: PipePause[];
}

export interface AppSettings {
  sunlightMode: boolean; // High contrast sunlight mode
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  defaultPipeLength: number; // Default 4.55 meters
  defaultFormation: string;
  defaultBitType: string;
  defaultBitDiameter: number;
  autoSyncWhenOnline: boolean;
}
