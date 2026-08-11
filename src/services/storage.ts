import {
  ActivePipeTimer,
  AppSettings,
  Borehole,
  DrillingEvent,
  PipeRecord,
  ShiftLog,
  User,
} from '../types';
import { Outbox } from './outbox';

/**
 * Queue of changes waiting to reach the server.
 *
 * Writes stay synchronous and local - a driller at a rig with no signal must
 * never wait on, or be blocked by, the network. Saving just drops an operation
 * here; a worker delivers it whenever connectivity returns.
 */
let outboxInstance: Outbox | null = null;
export function getOutbox(): Outbox {
  if (!outboxInstance) outboxInstance = new Outbox();
  return outboxInstance;
}

/**
 * Drop the cached queue so the next call re-reads localStorage.
 *
 * Needed wherever the underlying storage is swapped out from under us - tests
 * substituting a fresh localStorage, and resetToDemoData() wiping records that
 * queued operations still refer to.
 */
export function resetOutbox(): void {
  outboxInstance = null;
}

/**
 * Queue a record's parent borehole ahead of the record itself.
 *
 * The queue drains oldest-first, so a child sent before its parent exists on
 * the server is rejected by the foreign key. That happens whenever a borehole
 * was created through a path that did not queue it - one that predates syncing,
 * or was restored from a backup. Upserts for the same row coalesce, so calling
 * this on every save costs nothing.
 */
function enqueueParentFirst(boreholeId: string): void {
  if (!boreholeId) return;
  const borehole = DrillingStorage.getBoreholes().find((b) => b.id === boreholeId);
  if (!borehole || borehole.isDemo) return;
  getOutbox().enqueue('upsert', 'borehole', borehole.id, borehole);
}

const STORAGE_KEYS = {
  USERS: 'wwdm_users',
  CURRENT_USER_ID: 'wwdm_current_user_id',
  BOREHOLES: 'wwdm_boreholes',
  ACTIVE_BOREHOLE_ID: 'wwdm_active_borehole_id',
  PIPE_RECORDS: 'wwdm_pipe_records',
  EVENTS: 'wwdm_events',
  SHIFT_LOGS: 'wwdm_shift_logs',
  ACTIVE_TIMER: 'wwdm_active_timer',
  SETTINGS: 'wwdm_settings',
};

export const SAMPLE_USERS: User[] = [
  { id: 'usr-driller-1', name: 'James Wanjala', role: 'Driller', badgeNumber: 'DRL-104' },
  { id: 'usr-supervisor-1', name: 'Eng. Sarah Omondi', role: 'Supervisor', badgeNumber: 'SUP-021' },
  { id: 'usr-admin-1', name: 'David Mutua', role: 'Administrator', badgeNumber: 'ADM-001' },
];

const DEFAULT_USERS = SAMPLE_USERS;

// Seed collections are module constants, so hand out copies. Otherwise the first
// save() call would unshift straight into the shared demo array.
function cloneSeed<T>(seed: T[]): T[] {
  return JSON.parse(JSON.stringify(seed));
}

/**
 * Stamp seeded rows as demo data.
 *
 * Every install seeds the same boreholes, pipe records and events, with ids
 * that are identical across devices. Pushing those upstream would have ten
 * rigs collide on one fake borehole and bury the admin dashboard in it, so the
 * outbox drops anything carrying this flag. Real records the driller creates
 * never get it.
 */
function markDemo<T extends { isDemo?: boolean }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, isDemo: true }));
}

/**
 * Ids must be globally unique, not just unique on this device.
 *
 * The old scheme (`${prefix}-${Date.now().toString(36)}-${seq}`) used a
 * device-local counter, so two rigs saving in the same millisecond produced the
 * same id. Since the server upserts on primary key, that meant one crew
 * silently overwriting another's record. A UUID also makes retries idempotent:
 * replaying a queued upsert is harmless.
 *
 * The prefix is retained in the signature for call-site readability but no
 * longer appears in the value.
 */
export function createRecordId(_prefix?: string): string {
  return crypto.randomUUID();
}

// Records written before ids were assigned would all compare equal on `undefined`,
// which made every save overwrite the previous one. Heal them on read.
function withIds<T extends { id?: string }>(list: T[], prefix: string): { list: T[]; healed: boolean } {
  let healed = false;
  const next = list.map((item) => {
    if (item && !item.id) {
      healed = true;
      return { ...item, id: createRecordId(prefix) };
    }
    return item;
  });
  return { list: next, healed };
}

const DEFAULT_SETTINGS: AppSettings = {
  sunlightMode: false,
  soundEnabled: true,
  vibrationEnabled: true,
  defaultPipeLength: 4.55,
  defaultFormation: 'Weathered Basalt',
  defaultBitType: 'DTH Hammer - Button Bit',
  defaultBitDiameter: 8.5,
  autoSyncWhenOnline: true,
};

// Realistic geological formation list for quick selection
export const FORMATION_OPTIONS = [
  'Topsoil & Alluvium',
  'Soft Clay',
  'Stiff Sandy Clay',
  'Coarse Sand & Gravel',
  'Weathered Basalt',
  'Fractured Basalt (Water Bearing)',
  'Fresh Basalt / Dolerite',
  'Weathered Granite',
  'Fresh Granite',
  'Limestone / Dolomite',
  'Sandstone',
  'Shale / Mudstone',
  'Quartzite / Schist',
];

export const BIT_TYPE_OPTIONS = [
  'DTH Hammer - Button Bit',
  'DTH Hammer - Convex Bit',
  'Tricone Rock Bit - TCI',
  'Tricone Rock Bit - Mill Tooth',
  'PDC Drill Bit',
  'Drag / Clay Bit',
  'Reamer Bit',
];

export const BIT_DIAMETER_OPTIONS = [6.0, 6.5, 8.0, 8.5, 10.0, 12.25, 14.0];

// Demo Boreholes
const DEMO_BOREHOLES: Borehole[] = [
  {
    id: 'bh-2026-04',
    name: 'BH-2026-04 (Kibera Community Well #3)',
    project: 'Eastern Water Supply Project',
    client: 'Nairobi Water & Sanitation Co.',
    rigName: 'Rig #4 - Schramm T685WS',
    targetDepth: 160,
    currentDepth: 86.45,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer - Button Bit',
    gpsCoordinates: {
      lat: -1.3142,
      lng: 36.7845,
      elevation: 1680,
    },
    status: 'active',
    createdAt: new Date(Date.now() - 1000 * 3600 * 48).toISOString(),
    updatedAt: new Date().toISOString(),
    engineHoursStart: 4120.0,
    compressorHoursStart: 3080.5,
    currentEngineHours: 4144.2,
    currentCompressorHours: 3101.8,
    casingInstalledDepth: 24.0,
  },
  {
    id: 'bh-2026-02',
    name: 'BH-2026-02 (Naivasha Solar Park Well)',
    project: 'Rift Valley Irrigation & Solar',
    client: 'SunGrow Power Solutions',
    rigName: 'Rig #1 - Atlas Copco T3W',
    targetDepth: 140,
    currentDepth: 145.6,
    defaultPipeLength: 4.55,
    bitDiameter: 8.5,
    bitType: 'DTH Hammer - Button Bit',
    gpsCoordinates: {
      lat: -0.7167,
      lng: 36.4333,
      elevation: 1890,
    },
    status: 'completed',
    createdAt: new Date(Date.now() - 1000 * 3600 * 168).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 3600 * 96).toISOString(),
    engineHoursStart: 3890.0,
    compressorHoursStart: 2910.0,
    currentEngineHours: 3935.5,
    currentCompressorHours: 2948.0,
    casingInstalledDepth: 36.4,
  },
];

// Build realistic demo pipes for active borehole BH-2026-04 (19 pipes = 86.45m)
function generateDemoPipeRecords(): PipeRecord[] {
  const records: PipeRecord[] = [];
  const startEpoch = Date.now() - 1000 * 3600 * 30; // Started 30 hours ago
  const formations = [
    { upTo: 9.1, name: 'Topsoil & Alluvium', speed: 18.2 },
    { upTo: 18.2, name: 'Soft Clay', speed: 15.0 },
    { upTo: 27.3, name: 'Coarse Sand & Gravel', speed: 12.5 },
    { upTo: 45.5, name: 'Weathered Basalt', speed: 8.4 },
    { upTo: 72.8, name: 'Fractured Basalt (Water Bearing)', speed: 6.8 },
    { upTo: 150.0, name: 'Fresh Basalt / Dolerite', speed: 5.2 },
  ];

  let currentDepth = 0;
  for (let i = 1; i <= 19; i++) {
    const pipeLen = 4.55;
    const startDepth = parseFloat(currentDepth.toFixed(2));
    const endDepth = parseFloat((currentDepth + pipeLen).toFixed(2));
    const formObj = formations.find((f) => endDepth <= f.upTo) || formations[formations.length - 1];

    const penRate = formObj.speed + (Math.random() * 1.8 - 0.9);
    const durationHours = pipeLen / penRate;
    const durationSeconds = Math.round(durationHours * 3600);

    const startTimeEpoch = startEpoch + (i - 1) * 3600 * 1000 * 1.3;
    const endTimeEpoch = startTimeEpoch + durationSeconds * 1000;

    const isWaterStrike = i === 10; // at 45.5m

    records.push({
      id: `pipe-bh1-${i}`,
      boreholeId: 'bh-2026-04',
      pipeNumber: i,
      startDepth,
      endDepth,
      pipeLength: pipeLen,
      startTime: new Date(startTimeEpoch).toISOString(),
      endTime: new Date(endTimeEpoch).toISOString(),
      durationSeconds,
      penetrationRate: parseFloat(penRate.toFixed(2)),
      formation: formObj.name,
      waterStrike: isWaterStrike,
      waterStrikeDetails: isWaterStrike
        ? {
            depth: 44.5,
            flowRateLpm: 180,
            staticWaterLevel: 22.0,
            ec: 480,
            notes: 'Strong aquifer strike in fractured basalt. Clean water.',
          }
        : undefined,
      airPressure: 240 + Math.round(Math.random() * 20),
      compressorPressure: 210 + Math.round(Math.random() * 15),
      bitType: i <= 4 ? 'Drag / Clay Bit' : 'DTH Hammer - Button Bit',
      bitDiameter: 8.5,
      operator: 'James Wanjala',
      gpsCoordinates: { lat: -1.3142, lng: 36.7845 },
      remarks:
        i === 10
          ? 'Water strike confirmed at 44.5m! Good discharge.'
          : i === 5
            ? 'Changed bit to DTH hammer button bit for basalt.'
            : 'Smooth drilling progress.',
      synced: i <= 16, // pipes 17, 18, 19 are pending sync!
    });

    currentDepth = endDepth;
  }

  return records;
}

// Demo Drilling Events / NPT
const DEMO_EVENTS: DrillingEvent[] = [
  {
    id: 'ev-1',
    boreholeId: 'bh-2026-04',
    type: 'Bit Change',
    title: 'Changed Bit to DTH Button Hammer (8.5")',
    timestamp: new Date(Date.now() - 1000 * 3600 * 22).toISOString(),
    durationMinutes: 45,
    isNPT: true,
    operator: 'James Wanjala',
    depthAtEvent: 18.2,
    details: {
      newBitType: 'DTH Hammer - Button Bit',
      newBitDiameter: 8.5,
      notes: 'Transitioned from Drag Bit after clay zone into weathered basalt.',
    },
    synced: true,
  },
  {
    id: 'ev-2',
    boreholeId: 'bh-2026-04',
    type: 'Water Strike',
    title: 'Water Strike Recorded - 180 L/min',
    timestamp: new Date(Date.now() - 1000 * 3600 * 14).toISOString(),
    durationMinutes: 20,
    isNPT: false,
    operator: 'James Wanjala',
    depthAtEvent: 45.5,
    details: {
      waterStrikeDepth: 44.5,
      waterStrikeLpm: 180,
      staticWaterLevel: 22.0,
      notes: 'Clean freshwater strike in fractured basalt aquifer.',
    },
    synced: true,
  },
  {
    id: 'ev-3',
    boreholeId: 'bh-2026-04',
    type: 'Refueling',
    title: 'Rig & Compressor Refueling (220 Liters)',
    timestamp: new Date(Date.now() - 1000 * 3600 * 8).toISOString(),
    durationMinutes: 30,
    isNPT: true,
    operator: 'James Wanjala',
    depthAtEvent: 63.7,
    details: {
      fuelLiters: 220,
      fuelCost: 35200,
      engineHours: 4138.5,
      compressorHours: 3095.0,
      notes: 'Diesel refuel from field fuel truck.',
    },
    synced: false, // pending sync
  },
  {
    id: 'ev-4',
    boreholeId: 'bh-2026-04',
    type: 'Breakdown',
    title: 'Hydraulic Hose Replacement',
    timestamp: new Date(Date.now() - 1000 * 3600 * 5).toISOString(),
    durationMinutes: 55,
    isNPT: true,
    operator: 'James Wanjala',
    depthAtEvent: 72.8,
    details: {
      notes: 'Top drive rotary head hose minor leak. Replaced seal and hose fitting.',
    },
    synced: false,
  },
];

// Demo Shift Logs
const DEMO_SHIFT_LOGS: ShiftLog[] = [
  {
    id: 'sh-1',
    boreholeId: 'bh-2026-04',
    date: new Date(Date.now() - 1000 * 3600 * 24).toISOString().split('T')[0],
    shiftName: 'Day Shift (06:00 - 18:00)',
    drillerName: 'James Wanjala',
    supervisorName: 'Eng. Sarah Omondi',
    startDepth: 0,
    endDepth: 45.5,
    metersDrilledToday: 45.5,
    productiveHours: 9.5,
    nonProductiveHours: 2.5,
    fuelUsedLiters: 180,
    notes: 'Completed topsoil, clay and weathered basalt. Water strike encountered at 44.5m.',
  },
  {
    id: 'sh-2',
    boreholeId: 'bh-2026-04',
    date: new Date().toISOString().split('T')[0],
    shiftName: 'Day Shift (06:00 - 18:00)',
    drillerName: 'James Wanjala',
    supervisorName: 'Eng. Sarah Omondi',
    startDepth: 45.5,
    endDepth: 86.45,
    metersDrilledToday: 40.95,
    productiveHours: 8.2,
    nonProductiveHours: 1.8,
    fuelUsedLiters: 220,
    notes: 'Drilling through fractured and fresh basalt. Good penetration rate averaging 6.8 m/hr.',
  },
];

export class DrillingStorage {
  static getSettings(): AppSettings {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (!raw) {
      this.saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  static saveSettings(settings: AppSettings): void {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  }

  static getUsers(): User[] {
    const raw = localStorage.getItem(STORAGE_KEYS.USERS);
    if (!raw) {
      const seeded = cloneSeed(DEFAULT_USERS);
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(seeded));
      return seeded;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return cloneSeed(DEFAULT_USERS);
    }
  }

  static saveUser(user: User): void {
    const users = this.getUsers();
    const idx = users.findIndex((u) => u.id === user.id);
    if (idx >= 0) {
      users[idx] = user;
    } else {
      users.unshift(user);
    }
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));
  }

  static getCurrentUser(): User {
    const users = this.getUsers();
    const curId = localStorage.getItem(STORAGE_KEYS.CURRENT_USER_ID);
    const found = users.find((u) => u.id === curId);
    if (found) return found;
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, users[0].id);
    return users[0];
  }

  static setCurrentUser(userId: string): void {
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, userId);
  }

  static deleteUser(userId: string): void {
    const users = this.getUsers().filter((u) => u.id !== userId);
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(users));

    const currentId = localStorage.getItem(STORAGE_KEYS.CURRENT_USER_ID);
    if (currentId === userId) {
      const fallback = users[0];
      if (fallback) {
        localStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, fallback.id);
      } else {
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER_ID);
      }
    }
  }

  static getBoreholes(): Borehole[] {
    const raw = localStorage.getItem(STORAGE_KEYS.BOREHOLES);
    if (!raw) {
      const seeded = markDemo(cloneSeed(DEMO_BOREHOLES));
      localStorage.setItem(STORAGE_KEYS.BOREHOLES, JSON.stringify(seeded));
      return seeded;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return markDemo(cloneSeed(DEMO_BOREHOLES));
    }
  }

  static saveBorehole(borehole: Borehole): void {
    const list = this.getBoreholes();
    const idx = list.findIndex((b) => b.id === borehole.id);
    if (idx >= 0) {
      list[idx] = { ...borehole, updatedAt: new Date().toISOString() };
    } else {
      list.unshift(borehole);
    }
    localStorage.setItem(STORAGE_KEYS.BOREHOLES, JSON.stringify(list));
    getOutbox().enqueue('upsert', 'borehole', borehole.id, list[idx >= 0 ? idx : 0]);
  }

  static deleteBorehole(boreholeId: string): void {
    const remainingBoreholes = this.getBoreholes().filter((b) => b.id !== boreholeId);
    localStorage.setItem(STORAGE_KEYS.BOREHOLES, JSON.stringify(remainingBoreholes));

    const remainingPipeRecords = this.getPipeRecords().filter((r) => r.boreholeId !== boreholeId);
    localStorage.setItem(STORAGE_KEYS.PIPE_RECORDS, JSON.stringify(remainingPipeRecords));

    const remainingEvents = this.getEvents().filter((e) => e.boreholeId !== boreholeId);
    localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(remainingEvents));

    const remainingShiftLogs = this.getShiftLogs().filter((s) => s.boreholeId !== boreholeId);
    localStorage.setItem(STORAGE_KEYS.SHIFT_LOGS, JSON.stringify(remainingShiftLogs));

    this.clearActivePipeTimer(boreholeId);

    const activeId = localStorage.getItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID);
    if (activeId === boreholeId) {
      const nextActive = remainingBoreholes[0];
      if (nextActive) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID, nextActive.id);
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID);
      }
    }
  }

  static getActiveBorehole(): Borehole {
    const list = this.getBoreholes();
    const savedId = localStorage.getItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID);
    if (savedId) {
      const found = list.find((b) => b.id === savedId);
      if (found) return found;
    }
    const active = list.find((b) => b.status === 'active') || list[0];
    if (active) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID, active.id);
    }
    return active;
  }

  static setActiveBorehole(boreholeId: string): void {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID, boreholeId);
  }

  static getPipeRecords(boreholeId?: string): PipeRecord[] {
    const raw = localStorage.getItem(STORAGE_KEYS.PIPE_RECORDS);
    let list: PipeRecord[] = [];
    if (!raw) {
      list = markDemo(generateDemoPipeRecords());
      localStorage.setItem(STORAGE_KEYS.PIPE_RECORDS, JSON.stringify(list));
    } else {
      try {
        list = JSON.parse(raw);
      } catch {
        list = markDemo(generateDemoPipeRecords());
      }
      const healedPipes = withIds(list, 'pipe');
      if (healedPipes.healed) {
        list = healedPipes.list;
        localStorage.setItem(STORAGE_KEYS.PIPE_RECORDS, JSON.stringify(list));
      }
    }
    if (boreholeId) {
      return list
        .filter((r) => r.boreholeId === boreholeId)
        .sort((a, b) => a.pipeNumber - b.pipeNumber);
    }
    return list;
  }

  static savePipeRecord(record: PipeRecord): PipeRecord {
    const list = this.getPipeRecords();
    // An id-less record is always a new one. Matching on `undefined` would make
    // every save overwrite the previously saved id-less record.
    const stored: PipeRecord = record.id
      ? record
      : { ...record, id: createRecordId('pipe') };
    const idx = record.id ? list.findIndex((r) => r.id === record.id) : -1;
    if (idx >= 0) {
      list[idx] = stored;
    } else {
      list.push(stored);
    }
    localStorage.setItem(STORAGE_KEYS.PIPE_RECORDS, JSON.stringify(list));

    // Update borehole currentDepth if this pipe pushes depth further. This runs
    // before the pipe is queued so the parent row is always sent first.
    const boreholes = this.getBoreholes();
    const bh = boreholes.find((b) => b.id === stored.boreholeId);
    if (bh && stored.endDepth > bh.currentDepth) {
      bh.currentDepth = stored.endDepth;
      bh.updatedAt = new Date().toISOString();
      this.saveBorehole(bh);
    }
    enqueueParentFirst(stored.boreholeId);
    getOutbox().enqueue('upsert', 'pipeRecord', stored.id, stored);

    return stored;
  }

  static deletePipeRecord(idOrBh: string, maybeRecordId?: string): void {
    const recordId = maybeRecordId || idOrBh;
    // Without this guard an undefined id would filter out every id-less record.
    if (!recordId) return;
    const list = this.getPipeRecords();
    // Look the record up before removing it: the outbox needs the row to tell
    // demo seed data apart from a real record worth deleting server-side.
    const removed = list.find((r) => r.id === recordId);
    const filtered = list.filter((r) => r.id !== recordId);
    localStorage.setItem(STORAGE_KEYS.PIPE_RECORDS, JSON.stringify(filtered));
    if (removed) {
      getOutbox().enqueue('delete', 'pipeRecord', recordId, removed);
      // savePipeRecord raises currentDepth; deleting has to lower it again.
      // Left alone, the hole keeps the deleted pipe's end depth and the next
      // pipe starts below the bottom of the hole, opening a gap of undrilled
      // metres in a log that backs client billing.
      this.recalculateCurrentDepth(removed.boreholeId);
    }
  }

  /** Re-derive a borehole's depth from the pipes that actually remain. */
  private static recalculateCurrentDepth(boreholeId: string): void {
    const boreholes = this.getBoreholes();
    const bh = boreholes.find((b) => b.id === boreholeId);
    if (!bh) return;
    const remaining = this.getPipeRecords().filter(
      (r) => r.boreholeId === boreholeId
    );
    const deepest = remaining.reduce((max, r) => Math.max(max, r.endDepth), 0);
    if (deepest === bh.currentDepth) return;
    bh.currentDepth = deepest;
    bh.updatedAt = new Date().toISOString();
    this.saveBorehole(bh);
  }

  static getEvents(boreholeId?: string): DrillingEvent[] {
    const raw = localStorage.getItem(STORAGE_KEYS.EVENTS);
    let list: DrillingEvent[] = [];
    if (!raw) {
      list = markDemo(cloneSeed(DEMO_EVENTS));
      localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(list));
    } else {
      try {
        list = JSON.parse(raw);
      } catch {
        list = markDemo(cloneSeed(DEMO_EVENTS));
      }
      const healedEvents = withIds(list, 'ev');
      if (healedEvents.healed) {
        list = healedEvents.list;
        localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(list));
      }
    }
    if (boreholeId) {
      return list
        .filter((e) => e.boreholeId === boreholeId)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
    return list;
  }

  static saveEvent(event: DrillingEvent): DrillingEvent {
    const list = this.getEvents();
    const stored: DrillingEvent = event.id
      ? event
      : { ...event, id: createRecordId('ev') };
    const idx = event.id ? list.findIndex((e) => e.id === event.id) : -1;
    if (idx >= 0) {
      list[idx] = stored;
    } else {
      list.unshift(stored);
    }
    localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(list));
    enqueueParentFirst(stored.boreholeId);
    getOutbox().enqueue('upsert', 'event', stored.id, stored);
    return stored;
  }

  static deleteEvent(idOrBh: string, maybeEventId?: string): void {
    const eventId = maybeEventId || idOrBh;
    if (!eventId) return;
    const list = this.getEvents();
    const removed = list.find((e) => e.id === eventId);
    const filtered = list.filter((e) => e.id !== eventId);
    localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(filtered));
    if (removed) getOutbox().enqueue('delete', 'event', eventId, removed);
  }

  static getShiftLogs(boreholeId?: string): ShiftLog[] {
    const raw = localStorage.getItem(STORAGE_KEYS.SHIFT_LOGS);
    let list: ShiftLog[] = [];
    if (!raw) {
      list = markDemo(cloneSeed(DEMO_SHIFT_LOGS));
      localStorage.setItem(STORAGE_KEYS.SHIFT_LOGS, JSON.stringify(list));
    } else {
      try {
        list = JSON.parse(raw);
      } catch {
        list = markDemo(cloneSeed(DEMO_SHIFT_LOGS));
      }
    }
    if (boreholeId) {
      return list.filter((s) => s.boreholeId === boreholeId);
    }
    return list;
  }

  static saveShiftLog(log: ShiftLog): void {
    const list = this.getShiftLogs();
    const idx = list.findIndex((s) => s.id === log.id);
    if (idx >= 0) {
      list[idx] = log;
    } else {
      list.unshift(log);
    }
    localStorage.setItem(STORAGE_KEYS.SHIFT_LOGS, JSON.stringify(list));
    getOutbox().enqueue('upsert', 'shiftLog', log.id, log);
  }

  // Timers are stored per borehole. A single shared timer used to bleed across
  // projects, so switching borehole mid-pipe filed the pipe against the wrong one.
  private static readTimerMap(): Record<string, ActivePipeTimer> {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_TIMER);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      // Legacy shape: one bare timer object rather than a per-borehole map.
      if ('pipeNumber' in parsed) {
        const legacy = parsed as ActivePipeTimer;
        return legacy.boreholeId ? { [legacy.boreholeId]: legacy } : {};
      }
      return parsed as Record<string, ActivePipeTimer>;
    } catch {
      return {};
    }
  }

  private static writeTimerMap(map: Record<string, ActivePipeTimer>): void {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_TIMER, JSON.stringify(map));
  }

  static getActivePipeTimer(boreholeId?: string): ActivePipeTimer {
    const idleTimer = (): ActivePipeTimer => ({
      boreholeId,
      isActive: false,
      pipeNumber: 1,
      startDepth: 0,
      startTime: '',
      pipeLength: DEFAULT_SETTINGS.defaultPipeLength,
      formation: DEFAULT_SETTINGS.defaultFormation,
      airPressure: 250,
      compressorPressure: 220,
      bitType: DEFAULT_SETTINGS.defaultBitType,
      bitDiameter: DEFAULT_SETTINGS.defaultBitDiameter,
      remarks: '',
    });

    if (!boreholeId) return idleTimer();
    return this.readTimerMap()[boreholeId] || idleTimer();
  }

  static saveActivePipeTimer(timer: ActivePipeTimer): void {
    if (!timer.boreholeId) return;
    const map = this.readTimerMap();
    map[timer.boreholeId] = timer;
    this.writeTimerMap(map);
  }

  static getActiveTimer(boreholeId?: string): ActivePipeTimer {
    return this.getActivePipeTimer(boreholeId);
  }

  static saveActiveTimer(timer: ActivePipeTimer): void {
    this.saveActivePipeTimer(timer);
  }

  static clearActivePipeTimer(boreholeId?: string): void {
    if (!boreholeId) {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_TIMER);
      return;
    }
    const map = this.readTimerMap();
    delete map[boreholeId];
    this.writeTimerMap(map);
  }

  static clearActiveTimer(boreholeId?: string): void {
    this.clearActivePipeTimer(boreholeId);
  }

  // Count pending sync records across all collections
  /**
   * How much work is genuinely waiting to reach the server.
   *
   * This used to count records whose `synced` flag was false, but that flag was
   * only ever flipped by a simulated sync that made no network call - so the
   * badge could read zero while nothing had actually been uploaded. It now
   * reflects real queue depth.
   */
  static getPendingSyncCount(): number {
    return getOutbox().depth();
  }

  /** Operations that exhausted their retries and need a human to look at them. */
  static getParkedSyncCount(): number {
    return getOutbox().parked().length;
  }

  /**
   * Superseded by the outbox and SyncWorker.
   *
   * The previous implementation flipped every record's `synced` flag without
   * making a network call, so the UI reported a successful upload while
   * nothing had left the device.
   */

  // Export full backup as JSON
  static exportAllData(): string {
    const data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      boreholes: this.getBoreholes(),
      pipeRecords: this.getPipeRecords(),
      events: this.getEvents(),
      shiftLogs: this.getShiftLogs(),
      settings: this.getSettings(),
    };
    return JSON.stringify(data, null, 2);
  }

  // Import JSON backup
  static importData(jsonString: string): boolean {
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed.boreholes) localStorage.setItem(STORAGE_KEYS.BOREHOLES, JSON.stringify(parsed.boreholes));
      if (parsed.pipeRecords) localStorage.setItem(STORAGE_KEYS.PIPE_RECORDS, JSON.stringify(parsed.pipeRecords));
      if (parsed.events) localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify(parsed.events));
      if (parsed.shiftLogs) localStorage.setItem(STORAGE_KEYS.SHIFT_LOGS, JSON.stringify(parsed.shiftLogs));
      if (parsed.settings) localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(parsed.settings));
      return true;
    } catch {
      return false;
    }
  }

  // Reset demo data to initial factory state
  /**
   * Drop the seeded sample data, keeping anything the crew actually recorded.
   *
   * Every install seeds a demo borehole with nineteen pipe records so the app
   * is explorable before a real job exists. Once a device is linked to a real
   * project that fake job is just confusing on the rig, so linking clears it.
   *
   * Returns the number of rows removed. Real records are identified by the
   * absence of the isDemo flag and are never touched.
   */
  static clearDemoData(): number {
    let removed = 0;
    const prune = <T extends { isDemo?: boolean }>(key: string): T[] => {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      let list: T[];
      try {
        list = JSON.parse(raw) as T[];
      } catch {
        return [];
      }
      const kept = list.filter((row) => !row?.isDemo);
      removed += list.length - kept.length;
      localStorage.setItem(key, JSON.stringify(kept));
      return kept;
    };

    prune<PipeRecord>(STORAGE_KEYS.PIPE_RECORDS);
    prune<DrillingEvent>(STORAGE_KEYS.EVENTS);
    prune<ShiftLog>(STORAGE_KEYS.SHIFT_LOGS);
    const boreholes = prune<Borehole>(STORAGE_KEYS.BOREHOLES);

    // The active selection may have pointed at a borehole that just went away.
    const activeId = localStorage.getItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID);
    if (activeId && !boreholes.some((b) => b.id === activeId)) {
      if (boreholes.length > 0) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID, boreholes[0].id);
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACTIVE_BOREHOLE_ID);
      }
    }
    return removed;
  }

  /**
   * Make the signed-in account the only operator on this device.
   *
   * The seeded sample users are fake people. Leaving them selectable meant a
   * real driller's pipe records could be stamped with a demo name while
   * created_by recorded the true account, so the drilling log and the audit
   * trail disagreed about who did the work.
   */
  static adoptSignedInUser(profile: {
    id: string;
    name: string;
    role: string;
    badgeNumber: string;
  }): User {
    const user: User = {
      id: profile.id,
      name: profile.name || 'Operator',
      role: (profile.role as User['role']) ?? 'Driller',
      badgeNumber: profile.badgeNumber || '',
    };
    localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify([user]));
    localStorage.setItem(STORAGE_KEYS.CURRENT_USER_ID, user.id);
    return user;
  }

  static resetToDemoData(): void {
    localStorage.removeItem(STORAGE_KEYS.BOREHOLES);
    localStorage.removeItem(STORAGE_KEYS.PIPE_RECORDS);
    localStorage.removeItem(STORAGE_KEYS.EVENTS);
    localStorage.removeItem(STORAGE_KEYS.SHIFT_LOGS);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_TIMER);
  }

  // Instance method delegates so both static and instance calls work seamlessly
  getSettings(): AppSettings {
    return DrillingStorage.getSettings();
  }
  saveSettings(settings: AppSettings): void {
    DrillingStorage.saveSettings(settings);
  }
  getUsers(): User[] {
    return DrillingStorage.getUsers();
  }
  saveUser(user: User): void {
    DrillingStorage.saveUser(user);
  }
  getCurrentUser(): User {
    return DrillingStorage.getCurrentUser();
  }
  setCurrentUser(userId: string): void {
    DrillingStorage.setCurrentUser(userId);
  }
  deleteUser(userId: string): void {
    DrillingStorage.deleteUser(userId);
  }
  getBoreholes(): Borehole[] {
    return DrillingStorage.getBoreholes();
  }
  saveBorehole(borehole: Borehole): void {
    DrillingStorage.saveBorehole(borehole);
  }
  deleteBorehole(boreholeId: string): void {
    DrillingStorage.deleteBorehole(boreholeId);
  }
  getActiveBorehole(): Borehole {
    return DrillingStorage.getActiveBorehole();
  }
  setActiveBorehole(boreholeId: string): void {
    DrillingStorage.setActiveBorehole(boreholeId);
  }
  getPipeRecords(boreholeId?: string): PipeRecord[] {
    return DrillingStorage.getPipeRecords(boreholeId);
  }
  savePipeRecord(record: PipeRecord): PipeRecord {
    return DrillingStorage.savePipeRecord(record);
  }
  deletePipeRecord(idOrBh: string, maybeId?: string): void {
    DrillingStorage.deletePipeRecord(idOrBh, maybeId);
  }
  getEvents(boreholeId?: string): DrillingEvent[] {
    return DrillingStorage.getEvents(boreholeId);
  }
  saveEvent(event: DrillingEvent): DrillingEvent {
    return DrillingStorage.saveEvent(event);
  }
  deleteEvent(idOrBh: string, maybeId?: string): void {
    DrillingStorage.deleteEvent(idOrBh, maybeId);
  }
  getShiftLogs(boreholeId?: string): ShiftLog[] {
    return DrillingStorage.getShiftLogs(boreholeId);
  }
  saveShiftLog(log: ShiftLog): void {
    DrillingStorage.saveShiftLog(log);
  }
  getActivePipeTimer(boreholeId?: string): ActivePipeTimer {
    return DrillingStorage.getActivePipeTimer(boreholeId);
  }
  getActiveTimer(boreholeId?: string): ActivePipeTimer {
    return DrillingStorage.getActiveTimer(boreholeId);
  }
  saveActivePipeTimer(timer: ActivePipeTimer): void {
    DrillingStorage.saveActivePipeTimer(timer);
  }
  saveActiveTimer(timer: ActivePipeTimer): void {
    DrillingStorage.saveActiveTimer(timer);
  }
  clearActivePipeTimer(boreholeId?: string): void {
    DrillingStorage.clearActivePipeTimer(boreholeId);
  }
  clearActiveTimer(boreholeId?: string): void {
    DrillingStorage.clearActiveTimer(boreholeId);
  }
  getPendingSyncCount(): number {
    return DrillingStorage.getPendingSyncCount();
  }
  getParkedSyncCount(): number {
    return DrillingStorage.getParkedSyncCount();
  }
  exportAllData(): string {
    return DrillingStorage.exportAllData();
  }
  importData(jsonString: string): boolean {
    return DrillingStorage.importData(jsonString);
  }
  resetToDemoData(): void {
    DrillingStorage.resetToDemoData();
  }
}
