/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Directory, Filesystem } from '@capacitor/filesystem';

/**
 * Site photo capture and storage.
 *
 * Photos used to be read with `readAsDataURL` and kept, base64-encoded, inside
 * the record in localStorage. One 3MB phone photo becomes roughly 4MB of base64
 * against a ~5MB quota, so a couple of shots corrupted every other piece of app
 * data - long before anything reached the server.
 *
 * Now each photo is downscaled, written to the filesystem (IndexedDB-backed on
 * web, real files on Android) and queued for upload as its own operation, so a
 * slow photo cannot hold up the pipe records behind it.
 *
 * A thumbnail is produced at capture time because image transformation is a
 * paid Supabase feature; the dashboard lists thumbnails and fetches the full
 * image only when one is opened, which is what keeps monthly egress down.
 */

export const MAX_EDGE = 1600;
export const THUMB_EDGE = 320;
export const JPEG_QUALITY = 0.7;
export const THUMB_QUALITY = 0.6;

const PHOTO_DIR = 'photos';

/**
 * Scale an image to fit within `maxEdge`, preserving aspect ratio.
 *
 * Images already smaller than the bound are left alone - re-encoding a small
 * photo upward wastes bytes and quality.
 */
export function scaledDimensions(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Local filenames for a photo and its thumbnail. */
export function photoNames(photoId: string): { full: string; thumb: string } {
  return { full: `${photoId}.jpg`, thumb: `${photoId}_thumb.jpg` };
}

export function newPhotoId(): string {
  return crypto.randomUUID();
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode the selected image'));
    };
    img.src = url;
  });
}

/** Downscale and re-encode as JPEG. */
export async function compressImage(
  file: Blob,
  maxEdge: number,
  quality: number
): Promise<Blob> {
  const img = await loadImage(file);
  const { width, height } = scaledDimensions(img.naturalWidth, img.naturalHeight, maxEdge);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable on this device');
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality)
  );
  if (!blob) throw new Error('Could not compress the image');
  return blob;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      // Strip the `data:<mime>;base64,` prefix - Filesystem and Storage both
      // want the payload alone.
      resolve(result.slice(result.indexOf('base64,') + 'base64,'.length));
    };
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

export interface PreparedPhoto {
  id: string;
  /** Filename stored on the record and, under the author's folder, in the bucket. */
  fileName: string;
  thumbName: string;
  /** Data URL for immediate preview, so the UI does not re-read from disk. */
  previewUrl: string;
  bytes: number;
}

/**
 * Compress, thumbnail and persist a chosen image.
 *
 * Returns once both files are on disk, so the record can be saved knowing its
 * photo will survive an app restart even if the upload has not happened yet.
 */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const id = newPhotoId();
  const { full, thumb } = photoNames(id);

  const fullBlob = await compressImage(file, MAX_EDGE, JPEG_QUALITY);
  const thumbBlob = await compressImage(file, THUMB_EDGE, THUMB_QUALITY);

  const fullB64 = await blobToBase64(fullBlob);
  const thumbB64 = await blobToBase64(thumbBlob);

  await Filesystem.writeFile({
    path: `${PHOTO_DIR}/${full}`,
    data: fullB64,
    directory: Directory.Data,
    recursive: true,
  });
  await Filesystem.writeFile({
    path: `${PHOTO_DIR}/${thumb}`,
    data: thumbB64,
    directory: Directory.Data,
    recursive: true,
  });

  return {
    id,
    fileName: full,
    thumbName: thumb,
    previewUrl: `data:image/jpeg;base64,${thumbB64}`,
    bytes: fullBlob.size,
  };
}

/** Read a stored photo back as base64, for upload or for display. */
export async function readLocalPhoto(name: string): Promise<string> {
  const result = await Filesystem.readFile({
    path: `${PHOTO_DIR}/${name}`,
    directory: Directory.Data,
  });
  return typeof result.data === 'string' ? result.data : '';
}

export async function localPhotoDataUrl(name: string): Promise<string | null> {
  try {
    const b64 = await readLocalPhoto(name);
    return b64 ? `data:image/jpeg;base64,${b64}` : null;
  } catch {
    return null;
  }
}

/** Remove both files once they are safely on the server. */
export async function deleteLocalPhoto(photoId: string): Promise<void> {
  const { full, thumb } = photoNames(photoId);
  for (const name of [full, thumb]) {
    try {
      await Filesystem.deleteFile({
        path: `${PHOTO_DIR}/${name}`,
        directory: Directory.Data,
      });
    } catch {
      // Already gone; nothing to do.
    }
  }
}
