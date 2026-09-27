/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSupabase, PHOTO_BUCKET } from '../services/supabaseClient';
import {
  rowToBorehole,
  rowToEvent,
  rowToPipe,
  type BoreholeRow,
  type DrillingEventRow,
  type PipeRecordRow,
} from '../services/mappers';
import type { Borehole, DrillingEvent, PipeRecord } from '../types';

/**
 * Read-only queries for the administrator's dashboard.
 *
 * Everything here relies on RLS to scope results: an administrator's token sees
 * every crew's rows, a driller's token sees only their own. The dashboard sends
 * no filter of its own for that, so a misconfigured role cannot leak data
 * through a forgotten `where` clause.
 */

function client() {
  const c = getSupabase();
  if (!c) throw new Error('This build is not connected to a Supabase project');
  return c;
}

/** A borehole plus the bookkeeping columns the dashboard displays. */
export interface AdminBorehole extends Borehole {
  createdBy: string;
  deletedAt: string | null;
  receivedAt: string;
}

export async function fetchBoreholes(): Promise<AdminBorehole[]> {
  const { data, error } = await client()
    .from('boreholes')
    .select('*')
    .order('received_at', { ascending: false });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    ...rowToBorehole(row as BoreholeRow),
    createdBy: (row as BoreholeRow).created_by,
    deletedAt: (row as BoreholeRow).deleted_at ?? null,
    receivedAt: (row as { received_at: string }).received_at,
  }));
}

export interface AdminPipeRecord extends PipeRecord {
  deletedAt: string | null;
  createdBy: string;
}

export async function fetchPipeRecords(boreholeId: string): Promise<AdminPipeRecord[]> {
  const { data, error } = await client()
    .from('pipe_records')
    .select('*')
    .eq('borehole_id', boreholeId)
    .order('pipe_number', { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    ...rowToPipe(row as PipeRecordRow),
    deletedAt: (row as PipeRecordRow).deleted_at ?? null,
    createdBy: (row as PipeRecordRow).created_by,
  }));
}

export interface AdminEvent extends DrillingEvent {
  deletedAt: string | null;
  createdBy: string;
  photoPath: string | null;
}

export async function fetchEvents(boreholeId: string): Promise<AdminEvent[]> {
  const { data, error } = await client()
    .from('drilling_events')
    .select('*')
    .eq('borehole_id', boreholeId)
    .order('occurred_at', { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    ...rowToEvent(row as DrillingEventRow),
    deletedAt: (row as DrillingEventRow).deleted_at ?? null,
    createdBy: (row as DrillingEventRow).created_by,
    photoPath: (row as DrillingEventRow).photo_path ?? null,
  }));
}

/** A Drilling Paused event that has not been resumed yet. */
export function isOngoingPause(e: DrillingEvent & { deletedAt?: string | null }): boolean {
  return e.type === 'Drilling Paused' && !e.deletedAt && !e.details?.resumedAt;
}

/**
 * Rigs paused right now, keyed by borehole.
 *
 * The pause row is uploaded the moment the crew pauses, and gains
 * details.resumedAt when they resume, end or cancel the pipe - so an open one
 * means the rig was still stopped when the phone last had signal.
 */
export async function fetchOngoingPauses(): Promise<Map<string, AdminEvent>> {
  const { data, error } = await client()
    .from('drilling_events')
    .select('*')
    .eq('type', 'Drilling Paused')
    .is('deleted_at', null)
    .is('details->>resumedAt', null)
    .order('occurred_at', { ascending: true });
  if (error) throw new Error(error.message);

  const byBorehole = new Map<string, AdminEvent>();
  for (const row of data ?? []) {
    const r = row as DrillingEventRow;
    byBorehole.set(r.borehole_id, {
      ...rowToEvent(r),
      deletedAt: null,
      createdBy: r.created_by,
      photoPath: r.photo_path ?? null,
    });
  }
  return byBorehole;
}

export interface Profile {
  id: string;
  name: string;
  role: string;
  badge_number: string | null;
}

export async function fetchProfiles(): Promise<Map<string, Profile>> {
  const { data, error } = await client().from('profiles').select('*');
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((p) => [(p as Profile).id, p as Profile]));
}

/**
 * A viewable URL for a stored photo.
 *
 * The bucket is private, so this mints a short-lived signed URL. The thumbnail
 * is requested by default: it is roughly a thirtieth of the full image, and the
 * difference is what keeps a month of dashboard browsing inside the free tier's
 * egress allowance.
 */
export async function signedPhotoUrl(
  createdBy: string,
  fileName: string,
  variant: 'thumb' | 'full' = 'thumb'
): Promise<string | null> {
  const name =
    variant === 'thumb' ? fileName.replace(/\.jpg$/i, '_thumb.jpg') : fileName;
  const { data, error } = await client()
    .storage.from(PHOTO_BUCKET)
    .createSignedUrl(`${createdBy}/${name}`, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/**
 * Depth as measured, not as reported.
 *
 * boreholes.current_depth is a convenience column a stale device may have
 * pushed; the pipe records are the drilling record itself, so the dashboard
 * recomputes from them.
 */
export function measuredDepth(pipes: AdminPipeRecord[]): number {
  const live = pipes.filter((p) => !p.deletedAt);
  return live.reduce((max, p) => Math.max(max, p.endDepth), 0);
}
