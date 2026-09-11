/**
 * How a file is cut up on its way to storage.
 *
 * PURE and client-safe: the browser slices by it, the upload route validates by
 * it, and scripts/test-uploads.ts asserts it. No SDK, no `server-only`.
 */

/**
 * At or under this, one PUT. R2 would take up to 5 GB in one request, but a
 * single PUT on a 3G link that dies at 90% starts again from zero. Above it, the
 * file goes in parts and a dropped connection costs one part.
 */
export const SINGLE_PUT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Part size for a multipart upload. R2 requires every part except the last to
 * be the SAME size and at least 5 MiB, so this is fixed rather than adaptive.
 * 100 MB is 13 parts.
 */
export const PART_BYTES = 8 * 1024 * 1024;

/** The S3 protocol's ceiling. Far above anything the size caps allow. */
export const MAX_PARTS = 10_000;

export function usesMultipart(size: number): boolean {
  return size > SINGLE_PUT_MAX_BYTES;
}

export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / PART_BYTES));
}

/** Byte range of a 1-based part, end exclusive - the shape `Blob.slice` takes. */
export function partRange(size: number, partNumber: number): { start: number; end: number } {
  const start = (partNumber - 1) * PART_BYTES;
  return { start, end: Math.min(size, start + PART_BYTES) };
}
