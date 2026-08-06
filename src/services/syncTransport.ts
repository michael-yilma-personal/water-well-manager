/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PermanentSyncError, type OutboxEntity, type OutboxItem, type OutboxTransport } from './outbox';
import {
  boreholeToRow,
  eventToRow,
  pipeToRow,
  shiftLogToRow,
} from './mappers';
import type { Borehole, DrillingEvent, PipeRecord, ShiftLog } from '../types';

/** Postgres error codes that no amount of retrying will fix. */
const PERMANENT_PG_CODES = new Set([
  '42501', // insufficient_privilege - RLS rejected the write
  '23514', // check_violation
  '23502', // not_null_violation
  '22P02', // invalid_text_representation, e.g. a malformed uuid
]);

const TABLE_FOR: Record<Exclude<OutboxEntity, 'photo'>, string> = {
  borehole: 'boreholes',
  pipeRecord: 'pipe_records',
  event: 'drilling_events',
  shiftLog: 'shift_logs',
};

export interface TransportDeps {
  getClient: () => SupabaseClient | null;
  /** Resolves the signed-in user's id, or null when there is no session. */
  getUserId: () => Promise<string | null>;
  /** Injected for tests; defaults to wall clock. */
  now?: () => string;
}

// The target table is chosen at runtime from the queued entity, so the row
// shape cannot be narrowed statically here. Each branch is individually typed
// by its mapper and covered by round-trip tests in mappers.test.ts.
function toRow(
  entity: OutboxEntity,
  payload: unknown,
  userId: string
): Record<string, unknown> {
  switch (entity) {
    case 'borehole':
      return boreholeToRow(payload as Borehole, userId);
    case 'pipeRecord':
      return pipeToRow(payload as PipeRecord, userId);
    case 'event':
      return eventToRow(payload as DrillingEvent, userId);
    case 'shiftLog':
      return shiftLogToRow(payload as ShiftLog, userId);
    default:
      throw new PermanentSyncError(`no row mapping for entity "${entity}"`);
  }
}

function classify(error: { code?: string; message?: string } | null, context: string): Error {
  const message = `${context}: ${error?.message ?? 'unknown error'}`;
  if (error?.code && PERMANENT_PG_CODES.has(error.code)) {
    return new PermanentSyncError(message);
  }
  return new Error(message);
}

/**
 * Deliver one queued operation to Supabase.
 *
 * Auth is resolved here rather than when the record was written: a driller may
 * have logged for days offline, and demanding a live session at write time
 * would have blocked them at the rig. If the session is missing or stale the
 * item simply fails and is retried after the next refresh.
 */
export function createSupabaseTransport(deps: TransportDeps): OutboxTransport {
  const now = deps.now ?? (() => new Date().toISOString());

  return async (item: OutboxItem): Promise<void> => {
    const client = deps.getClient();
    if (!client) {
      throw new Error('Supabase is not configured on this build');
    }

    const userId = await deps.getUserId();
    if (!userId) {
      // Transient by design - retry once the session refreshes.
      throw new Error('no active session; will retry after sign-in');
    }

    if (item.entity === 'photo') {
      throw new PermanentSyncError('photo uploads are handled by the photo transport');
    }

    const table = TABLE_FOR[item.entity];

    if (item.op === 'delete') {
      // Soft delete: this is an audit log, so the row stays and is marked.
      const { error } = await client
        .from(table)
        .update({ deleted_at: now() })
        .eq('id', item.entityId);
      if (error) throw classify(error, `soft-delete ${table}/${item.entityId}`);
      return;
    }

    const row = toRow(item.entity, item.payload, userId);
    // Upsert on the primary key makes a replay harmless. When the conflicting
    // row belongs to a different user, RLS rejects the update rather than
    // letting one crew overwrite another's work.
    const { error } = await client.from(table).upsert(row, { onConflict: 'id' });
    if (error) throw classify(error, `upsert ${table}/${item.entityId}`);
  };
}
