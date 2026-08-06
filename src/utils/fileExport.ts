/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Hand a generated report to the user.
 *
 * jsPDF's `doc.save()` and `XLSX.writeFile()` both finish by creating an
 * anchor with a `download` attribute pointing at a `blob:` URL and clicking it.
 * That works in a browser, but inside Capacitor's Android WebView it is a
 * silent no-op: Capacitor never calls `WebView.setDownloadListener(...)`, so
 * the WebView drops the download without an error, a log line, or a file. The
 * report bytes are generated correctly and then thrown away.
 *
 * On native we therefore write the bytes ourselves and open the system share
 * sheet, which also matches how a driller actually gets a log off the rig:
 * straight into email, WhatsApp, Drive, or Files.
 */
export async function saveReportFile(
  base64: string,
  filename: string,
  mimeType: string
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    downloadInBrowser(base64, filename, mimeType);
    return;
  }

  // Cache is writable on every API level without a runtime storage permission,
  // and Capacitor's FileProvider will vend a shareable content:// URI for it.
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  try {
    await Share.share({
      title: filename,
      url: uri,
      dialogTitle: 'Export drilling report',
    });
  } catch (err) {
    // Dismissing the share sheet rejects the promise. The file is already on
    // disk at that point, so this is not a failed export.
    if (!isShareDismissal(err)) throw err;
  }
}

function isShareDismissal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(message) || /abort/i.test(message);
}

function downloadInBrowser(
  base64: string,
  filename: string,
  mimeType: string
): void {
  const blob = new Blob([base64ToBytes(base64)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoking immediately can race the browser's own fetch of the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const MIME_PDF = 'application/pdf';
export const MIME_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
