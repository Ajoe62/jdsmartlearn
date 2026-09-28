/**
 * Turn ResultPeak's stored photo into bytes we are willing to send.
 *
 * NO `server-only`, so the tests can import it by relative path under tsx. It
 * touches no secret and no Firestore handle.
 */

/**
 * ResultPeak re-encodes every photo to a ~30-45 KB, 350x450 JPEG. Four times that
 * is generous headroom and still refuses a document somebody stuffed by hand in
 * the console.
 */
export const MAX_PHOTO_BYTES = 256 * 1024;

const JPEG_DATA_URI = /^data:image\/jpe?g;base64,/i;

/**
 * The JPEG bytes of a stored data URI, or null.
 *
 * JPEG ONLY, by magic bytes as well as by the declared type. The route sends a
 * fixed `image/jpeg`; checking the bytes means the header can never describe
 * something else, and anything that is not a JPEG - an SVG that could carry
 * script included - is simply not served.
 */
export function decodeJpegDataUri(value: unknown, maxBytes = MAX_PHOTO_BYTES): Buffer | null {
  if (typeof value !== "string") return null;
  const match = JPEG_DATA_URI.exec(value);
  if (!match) return null;

  // Base64 is 4 chars per 3 bytes. Refuse before decoding, not after.
  const b64 = value.slice(match[0].length);
  if (b64.length === 0 || b64.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;

  const bytes = Buffer.from(b64, "base64");
  if (bytes.length < 3 || bytes.length > maxBytes) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return bytes;
}
