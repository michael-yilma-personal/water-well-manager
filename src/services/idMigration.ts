/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-time rewrite of legacy record ids to UUIDs.
 *
 * Ids used to come from a device-local counter
 * (`${prefix}-${Date.now().toString(36)}-${seq}`), and the demo boreholes ship
 * with hardcoded ids identical on every install. Because the server upserts on
 * primary key, two rigs would collide and silently overwrite each other's work.
 *
 * Rewriting an id is only half the job: every record that points at it has to
 * move with it, including the active-borehole selection and the running pipe
 * timer map. A missed reference means a driller's in-progress pipe or an entire
 * borehole's history quietly detaches.
 *
 * Runs before the first sync and is idempotent.
 */

export const STORAGE_KEYS_FOR_MIGRATION = {
  BOREHOLES: 'wwdm_boreholes',
  PIPE_RECORDS: 'wwdm_pipe_records',
  EVENTS: 'wwdm_events',
  SHIFT_LOGS: 'wwdm_shift_logs',
  ACTIVE_TIMER: 'wwdm_active_timer',
  ACTIVE_BOREHOLE_ID: 'wwdm_active_borehole_id',
} as const;

const K = STORAGE_KEYS_FOR_MIGRATION;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface MigrationReport {
  /** Number of records given a new id. */
  migrated: number;
  /** Records whose parent borehole could not be resolved. */
  orphaned: number;
}

interface WithId {
  id?: string;
  [key: string]: unknown;
}

interface WithParent extends WithId {
  boreholeId?: string;
  orphaned?: boolean;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write back only if the key already existed.
 *
 * Seeding is gated on a key being absent (`if (!raw) { seed... }`), so writing
 * an empty array to a fresh install convinces storage that demo data was
 * already created. The app then starts with no boreholes at all and the header
 * crashes dereferencing the active one.
 */
function writeIfPresent(key: string, value: unknown): void {
  if (localStorage.getItem(key) === null) return;
  localStorage.setItem(key, JSON.stringify(value));
}

export function migrateRecordIdsToUuid(): MigrationReport {
  const report: MigrationReport = { migrated: 0, orphaned: 0 };

  const boreholes = read<WithId[]>(K.BOREHOLES, []);
  const pipes = read<WithParent[]>(K.PIPE_RECORDS, []);
  const events = read<WithParent[]>(K.EVENTS, []);
  const shiftLogs = read<WithParent[]>(K.SHIFT_LOGS, []);

  // old borehole id -> new borehole id
  const boreholeIdMap = new Map<string, string>();

  for (const borehole of boreholes) {
    if (!borehole?.id || isUuid(borehole.id)) continue;
    const next = crypto.randomUUID();
    boreholeIdMap.set(borehole.id, next);
    borehole.id = next;
    report.migrated++;
  }

  const repoint = (rows: WithParent[]): void => {
    for (const row of rows) {
      if (row?.id && !isUuid(row.id)) {
        row.id = crypto.randomUUID();
        report.migrated++;
      }
      const parent = row?.boreholeId;
      if (typeof parent !== 'string' || isUuid(parent)) continue;

      const mapped = boreholeIdMap.get(parent);
      if (mapped) {
        row.boreholeId = mapped;
        delete row.orphaned;
      } else {
        // Parent is gone. Keep the row and its original pointer so the data can
        // still be recovered by hand; dropping field measurements is never the
        // right failure mode.
        row.orphaned = true;
        report.orphaned++;
      }
    }
  };

  repoint(pipes);
  repoint(events);
  repoint(shiftLogs);

  // The timer map is keyed by borehole id, and its values embed the id again.
  const timers = read<Record<string, { boreholeId?: string }>>(K.ACTIVE_TIMER, {});
  const nextTimers: Record<string, { boreholeId?: string }> = {};
  for (const [key, timer] of Object.entries(timers ?? {})) {
    const mappedKey = boreholeIdMap.get(key) ?? key;
    const mappedInner = timer?.boreholeId ? boreholeIdMap.get(timer.boreholeId) : undefined;
    nextTimers[mappedKey] = mappedInner
      ? { ...timer, boreholeId: mappedInner }
      : { ...timer };
  }

  writeIfPresent(K.BOREHOLES, boreholes);
  writeIfPresent(K.PIPE_RECORDS, pipes);
  writeIfPresent(K.EVENTS, events);
  writeIfPresent(K.SHIFT_LOGS, shiftLogs);
  writeIfPresent(K.ACTIVE_TIMER, nextTimers);

  // DrillingStorage stores this one as a bare string, not JSON. Re-encoding it
  // would yield a quoted value that matches no borehole id, leaving the app
  // with no active borehole.
  const activeId = localStorage.getItem(K.ACTIVE_BOREHOLE_ID);
  if (activeId) {
    const mapped = boreholeIdMap.get(activeId);
    if (mapped) localStorage.setItem(K.ACTIVE_BOREHOLE_ID, mapped);
  }

  return report;
}
