import "server-only";
import { r2Configured, r2Delete, r2Get, r2Put } from "./r2";

/**
 * THE ONLY entry point for file storage in this codebase - same pattern as
 * src/lib/ai/provider.ts. No storage SDK is imported anywhere else; swapping
 * providers must stay a one-file change.
 *
 * Current provider: Cloudflare R2 (free tier, zero egress). Firebase Storage
 * remains forbidden - it would force the shared project onto Blaze.
 */

/** File types we store and how to serve them. */
export const STORABLE_TYPES: Record<string, { mime: string; inline: boolean }> = {
  ".pdf": { mime: "application/pdf", inline: true },
  ".docx": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    inline: false, // browsers can't render docx - always download
  },
  ".txt": { mime: "text/plain; charset=utf-8", inline: true },
  /**
   * Photographs of handwritten work. Added for assignment submissions: a child
   * with an exercise book and a phone camera has no other way to hand in
   * written work, and it is the common case in these schools.
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
