import "server-only";
import {
  r2AbortMultipart,
  r2CompleteMultipart,
  r2Configured,
  r2Copy,
  r2CreateMultipart,
  r2Delete,
  r2Get,
  r2Head,
  r2PresignGet,
  r2PresignPart,
  r2PresignPut,
  r2Put,
} from "./r2";

/**
 * THE ONLY entry point for file storage in this codebase - same pattern as
 * src/lib/ai/provider.ts. No storage SDK is imported anywhere else; swapping
 * providers must stay a one-file change.
 *
 * Current provider: Cloudflare R2 (free tier, zero egress).
 *
 * FIREBASE STORAGE REMAINS FORBIDDEN, and the reason is no longer the billing
 * plan. It used to be: Storage would have forced the shared project onto Blaze.
 * The project moved to Blaze anyway for scheduled backups, so that argument has
 * expired and the rule has to stand on the reasons that outlive it.
 *
 * 1. ZERO EGRESS. The access pattern here is a class of students re-downloading
 *    the same lesson PDF on metered phone connections. That is the shape GCS
 *    bills hardest for and the shape R2 charges nothing for.
 * 2. ONE DELETION PATH. A school purge has to delete every file this product
 *    holds. Two storage backends means two sweeps, and the second one is the one
 *    somebody forgets - see docs/resultpeak-deletion-protocol-prompt.md.
 * 3. SEPARATE CREDENTIALS. Files live outside the Firebase project ResultPeak
 *    shares with us, so neither product can reach the other's objects at all.
 *
 * HOW BYTES MOVE (since 2026-09-11). A Vercel function refuses any request or
 * response body over 4.5 MB, so large files never pass through one. Uploads PUT
 * straight to R2 on a presigned address and are claimed by a route
 * (storage/uploads.ts); downloads over 4 MB are a redirect to a presigned GET
 * issued only after the file route has authorized the reader (storage/serve.ts).
 * See docs/ARCHITECTURE.md.
 */

/**
 * File types we store and how to serve them. The MIME type of every stored
 * object comes from HERE, by extension - never from the browser that sent it.
 */
export const STORABLE_TYPES: Record<string, { mime: string; inline: boolean }> = {
  ".pdf": { mime: "application/pdf", inline: true },
  ".doc": { mime: "application/msword", inline: false },
  ".docx": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    inline: false, // browsers can't render Office files - always download
  },
  ".ppt": { mime: "application/vnd.ms-powerpoint", inline: false },
  ".pptx": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    inline: false,
  },
  ".xls": { mime: "application/vnd.ms-excel", inline: false },
  ".xlsx": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    inline: false,
  },
  ".txt": { mime: "text/plain; charset=utf-8", inline: true },
  /**
   * Photographs: of handwritten work on a submission, or of a printed page a
   * tutor has no digital copy of. A child with an exercise book and a phone
   * camera has no other way to hand in written work.
   *
   * There is no text extractor for an image. The grading route sends it to the
   * provider's vision path instead, and a submission that is images only is
   * graded from the pictures alone.
   */
  ".jpg": { mime: "image/jpeg", inline: true },
  ".jpeg": { mime: "image/jpeg", inline: true },
  ".png": { mime: "image/png", inline: true },
};

export function storageConfigured(): boolean {
  return r2Configured();
}

export async function putFile(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2Put(key, body, contentType);
}

export async function getFile(
  key: string
): Promise<{ body: Buffer; contentType?: string } | null> {
  return r2Get(key);
}

export async function deleteFile(key: string): Promise<void> {
  await r2Delete(key);
}

export async function statFile(
  key: string
): Promise<{ size: number; contentType?: string } | null> {
  return r2Head(key);
}

export async function copyFile(fromKey: string, toKey: string, contentType: string): Promise<void> {
  await r2Copy(fromKey, toKey, contentType);
}

export async function presignUpload(
  key: string,
  contentType: string,
  expiresIn: number
): Promise<string> {
  return r2PresignPut(key, contentType, expiresIn);
}

export async function startMultipartUpload(key: string, contentType: string): Promise<string> {
  return r2CreateMultipart(key, contentType);
}

export async function presignUploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn: number
): Promise<string> {
  return r2PresignPart(key, uploadId, partNumber, expiresIn);
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<void> {
  await r2CompleteMultipart(key, uploadId, parts);
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  await r2AbortMultipart(key, uploadId);
}

export async function presignDownload(
  key: string,
  opts: { expiresIn: number; contentType: string; disposition: string }
): Promise<string> {
  return r2PresignGet(key, opts);
}
