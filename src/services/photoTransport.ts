/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PermanentSyncError, type OutboxItem } from './outbox';
import { PHOTO_BUCKET } from './supabaseClient';
import { deleteLocalPhoto, photoNames, readLocalPhoto } from './photos';

/**
 * Upload a captured photo to Supabase Storage.
 *
 * Objects are keyed `<uid>/<filename>` because the bucket policy authorises on
 * the leading folder - that is what stops one crew reading another's photos.
 *
 * This runs as its own queued operation rather than as part of the record it
 * belongs to. A 300KB upload over a weak link can take minutes or fail
 * repeatedly, and the pipe log behind it must not wait.
 */

export interface PhotoUploadPayload {
  photoId: string;
  /** Present on the record; the bucket key is this under the author's folder. */
  fileName: string;
  thumbName: string;
}

export interface PhotoTransportDeps {
  getClient: () => SupabaseClient | null;
  getUserId: () => Promise<string | null>;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createPhotoTransport(deps: PhotoTransportDeps) {
  return async (item: OutboxItem): Promise<void> => {
    const client = deps.getClient();
    if (!client) throw new Error('Supabase is not configured on this build');

    const userId = await deps.getUserId();
    if (!userId) throw new Error('no active session; will retry after sign-in');

    const payload = item.payload as PhotoUploadPayload;
    if (!payload?.photoId) {
      throw new PermanentSyncError('photo operation carries no photo id');
    }

    const { full, thumb } = photoNames(payload.photoId);

    for (const name of [thumb, full]) {
      // Thumbnail first: it is a tenth of the size, so on a marginal link the
      // dashboard gets something viewable even if the full image is still
      // retrying.
      let base64: string;
      try {
        base64 = await readLocalPhoto(name);
      } catch {
        // The file is gone from the device. Retrying cannot conjure it back.
        throw new PermanentSyncError(`local photo ${name} is missing`);
      }
      if (!base64) throw new PermanentSyncError(`local photo ${name} is empty`);

      const { error } = await client.storage
        .from(PHOTO_BUCKET)
        .upload(`${userId}/${name}`, base64ToBytes(base64), {
          contentType: 'image/jpeg',
          // Replaying a queued upload must be harmless.
          upsert: true,
        });

      if (error) {
        const message = `upload ${name}: ${error.message}`;
        // A storage policy rejection will not resolve by waiting.
        if (/row-level security|not authorized|Unauthorized/i.test(error.message)) {
          throw new PermanentSyncError(message);
        }
        throw new Error(message);
      }
    }

    // Both copies are on the server; reclaim the device's space.
    await deleteLocalPhoto(payload.photoId);
  };
}

/**
 * Route each queued operation to the transport that understands it.
 *
 * Photos go to object storage and records go to tables, but they share one
 * queue so their ordering and retry behaviour stay consistent.
 */
export function createCompositeTransport(
  recordTransport: (item: OutboxItem) => Promise<void>,
  photoTransport: (item: OutboxItem) => Promise<void>
) {
  return (item: OutboxItem): Promise<void> =>
    item.entity === 'photo' ? photoTransport(item) : recordTransport(item);
}
