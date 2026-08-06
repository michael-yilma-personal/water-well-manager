/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getOutbox } from './storage';
import type { PreparedPhoto } from './photos';
import type { PhotoUploadPayload } from './photoTransport';

/**
 * Queue a captured photo for upload.
 *
 * Separate from the record that references it on purpose. A 300KB image over a
 * marginal link can take minutes or fail repeatedly, and the pipe log behind it
 * must not wait - the outbox retries each item on its own schedule.
 *
 * Lives in its own module so the event modal does not have to import the
 * storage layer's queue directly.
 */
export function queuePhotoUpload(prepared: PreparedPhoto): void {
  const payload: PhotoUploadPayload = {
    photoId: prepared.id,
    fileName: prepared.fileName,
    thumbName: prepared.thumbName,
  };
  getOutbox().enqueue('upload', 'photo', prepared.id, payload);
}
