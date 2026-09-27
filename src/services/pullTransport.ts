/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  rowToBorehole,
  rowToEvent,
  rowToPipe,
  rowToShiftLog,
  type BoreholeRow,
  type DrillingEventRow,
  type PipeRecordRow,
  type ShiftLogRow,
} from './mappers';
import type { RemoteSnapshot } from './storage';

/**
 * Download this account's work from the server.
 *
 * The app was upload-only for its whole life, which is why the same login on a
 * second phone showed nothing: records reached Supabase and stopped there.
 *
 * Scoped to the signed-in account, not to a crew: a second driller signing in
 * on a shared rig phone still will not see the first driller's boreholes. The
 * scope is an explicit created_by filter, not left to RLS - Supervisors can
 * read every crew for review, and their phone must not download it all.
 *
 * Rows are followed by `modified_at`, which the server moves on every write,
 * so a record corrected in the office after upload comes back down. The older
 * `received_at` is set once at insert and never saw a correction.
 */

/**
 * How far back of already-seen time to re-request on each pull.
 *
 * `modified_at` is stamped with now() by the server, and two rows committed in the same
 * moment can be stamped out of order relative to when the queries see them. A
 * strict lower bound at the last watermark would step over the straggler and
 * never look at that instant again, losing the record permanently. Re-reading a
 * minute of overlap is idempotent - the merge is keyed by id - and costs a
 * handful of rows.
 */
export const PULL_OVERLAP_MS = 60_000;

export interface PullDeps {
  getClient: () => SupabaseClient | null;
  /** Resolves the signed-in user's id, or null when there is no session. */
  getUserId: () => Promise<string | null>;
}

export interface PullResult {
  snapshot: RemoteSnapshot;
  /** Newest `modified_at` seen, to be handed back to the next pull. */
  watermark: string | null;
}

export type Pull = (since: string | null) => Promise<PullResult | null>;

interface ServerRow {
  id: string;
  modified_at?: string;
  deleted_at?: string | null;
}

const TABLES = ['boreholes', 'pipe_records', 'drilling_events', 'shift_logs'] as const;

export function createSupabasePull(deps: PullDeps): Pull {
  return async (since: string | null): Promise<PullResult | null> => {
    const client = deps.getClient();
    if (!client) return null;

    // No session means no auth.uid(), so RLS would return an empty set anyway.
    // Returning early keeps an unlinked device from looking like an account
    // whose records have all vanished.
    const userId = await deps.getUserId();
    if (!userId) return null;

    const lowerBound =
      since === null
        ? null
        : new Date(Date.parse(since) - PULL_OVERLAP_MS).toISOString();

    const fetched: Record<string, ServerRow[]> = {};
    for (const table of TABLES) {
      // The builder is narrowed per-table by postgrest's generics, which the
      // runtime table name defeats; each row is typed by its mapper instead.
      let query = (client.from(table) as unknown as {
        select: (cols: string) => Record<string, (...args: unknown[]) => unknown>;
      }).select('*') as Record<string, (...args: unknown[]) => unknown>;

      query = query.eq('created_by', userId) as typeof query;
      if (lowerBound !== null) {
        query = query.gte('modified_at', lowerBound) as typeof query;
      }
      query = query.order('modified_at', { ascending: true }) as typeof query;

      const { data, error } = (await (query as unknown as Promise<{
        data: ServerRow[] | null;
        error: { message: string } | null;
      }>)) ?? { data: null, error: null };

      if (error) throw new Error(`pull ${table}: ${error.message}`);
      fetched[table] = data ?? [];
    }

    const deletedIds: string[] = [];
    let watermark = since;

    /** Split one table's rows into live records and upstream deletions. */
    const live = <T>(table: string, map: (row: never) => T): T[] => {
      const out: T[] = [];
      for (const row of fetched[table]) {
        if (row.modified_at && (watermark === null || row.modified_at > watermark)) {
          watermark = row.modified_at;
        }
        if (row.deleted_at) {
          deletedIds.push(row.id);
          continue;
        }
        out.push(map(row as never));
      }
      return out;
    };

    const snapshot: RemoteSnapshot = {
      boreholes: live('boreholes', (row: BoreholeRow) => rowToBorehole(row)),
      pipeRecords: live('pipe_records', (row: PipeRecordRow) => rowToPipe(row)),
      events: live('drilling_events', (row: DrillingEventRow) => rowToEvent(row)),
      shiftLogs: live('shift_logs', (row: ShiftLogRow) => rowToShiftLog(row)),
      deletedIds,
    };

    return { snapshot, watermark };
  };
}

export interface PullRunnerDeps {
  pull: Pull;
  readWatermark: () => string | null;
  writeWatermark: (watermark: string) => void;
  merge: (snapshot: RemoteSnapshot) => void;
}

/**
 * One pull, with the watermark carried across calls.
 *
 * The merge happens before the watermark moves. Reversed, a crash between the
 * two would advance past rows that were never written to the device, and the
 * pull would never look at that window again - the records would exist on the
 * server and nowhere else the driller can see.
 *
 * Resolves false when there was nothing to do (no session, no configured
 * project) and throws when the server was asked and refused, so the caller can
 * tell "not signed in" apart from "the download is broken".
 */
export function createPullRunner(deps: PullRunnerDeps): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    const result = await deps.pull(deps.readWatermark());
    if (!result) return false;
    deps.merge(result.snapshot);
    if (result.watermark !== null) deps.writeWatermark(result.watermark);
    return true;
  };
}
