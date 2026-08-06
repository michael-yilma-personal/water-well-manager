export type UserRole = 'Driller' | 'Supervisor' | 'Administrator';

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
  id: string;
  boreholeId: string;
  pipeNumber: number;
  startDepth: number; // meters
  endDepth: number; // meters
  pipeLength: number; // meters
  startTime: string; // ISO string
  endTime: string; // ISO string
  durationSeconds: number; // seconds
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
  | 'General Note';

export interface DrillingEvent {
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
  };
  synced: boolean;
}

export interface ShiftLog {
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
