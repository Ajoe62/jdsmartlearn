/**
 * What a crest may be, now that ResultPeak owns the bytes.
 *
 * THIS FILE USED TO BE AN UPLOAD VALIDATOR. It measured PNG headers, decided
 * whether a crest was square enough to install as a home-screen icon, and
 * capped the file size. All of that belonged to a form in this repo that no
 * longer exists: ResultPeak has owned the crest since 2026-08-29, validates it
 * on its own upload path, and this repo only ever reads.
 *
 * The validator was deleted rather than kept "in case", for the same reason the
 * form was. Upload validation sitting next to no upload is an invitation to
 * build a second upload, and a second upload is the defect the handover fixed.
 *
 * What is left is the two questions a READER has to answer: may this value go
 * in an `img src`, and will it still paint with the network off.
 */

/**
 * Content types this repo will serve back from /api/schools/{id}/logo.
 *
 * A SERVING allowlist, not an upload one. It decides what Content-Type a
 * browser is handed, which decides what the browser will execute, so it is
 * checked against the type decoded from the data URI and never trusted from it.
 *
 * SVG is here because a crest uploaded before the handover could be one, and
 * the route serves it with a null CSP and nosniff. Nothing can add a new SVG
 * crest any more: ResultPeak refuses SVG on upload, and isSafeCrestUrl refuses
 * it on read.
 */
export const CREST_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;

export type CrestType = (typeof CREST_TYPES)[number];

/**
 * Whether a crest URL from ResultPeak's record is safe to put in an `img src`.
 *
 * ResultPeak stores its crest as a DATA URI on `schools/{id}.branding.logoUrl`
 * (it has no bucket, and CLAUDE.md forbids adding one here), and allows an https
 * URL for a school pointing at an image it already hosts. This repo's own crest
 * is neither: it is an R2 key served from /api/schools/{id}/logo, which is why
 * this only ever runs on the ResultPeak fallback.
 *
 * SVG IS REFUSED, including as a data URI, and that is the point of the
 * function. An SVG is a document that can carry script; the upload path here
 * serves one only with a null CSP and nosniff, and a value arriving from another
 * product's record has had none of that applied. `javascript:` is inert in an
 * `img src` in every current browser, and is refused anyway rather than left to
 * the browser's good manners.
 */
const SAFE_CREST_URL = /^(https:\/\/|data:image\/(png|jpe?g|webp|gif);base64,)/i;

export function isSafeCrestUrl(value: unknown): boolean {
  const url = String(value ?? "").trim();
  if (!url) return false;
  if (/^data:image\/svg/i.test(url)) return false;
  return SAFE_CREST_URL.test(url);
}

/**
 * Whether a crest will still render with the network off.
 *
 * A `data:` URI is self-contained, so it survives in IndexedDB and paints
 * offline. A same-origin path is fetched through the service worker, which
 * already caches /api/schools/{id}/logo. A CROSS-ORIGIN https URL is neither:
 * the service worker's deny-list refuses every cross-origin request as its
 * second check, and that list is not changeable for this (CLAUDE.md).
 *
 * So a cross-origin crest is dropped from the student device payload rather
 * than saved and left to fail. What the child sees offline is the school's
 * monogram in the school's colour, which is the documented degrade: the school
 * name in text, never a broken image.
 */
export function isOfflineSafeCrest(value: unknown): boolean {
  const url = String(value ?? "").trim();
  if (!url) return false;
  if (url.startsWith("/")) return true;
  return /^data:image\//i.test(url) && isSafeCrestUrl(url);
}

/**
 * The URL a page uses for a school's crest.
 *
 * A PURE FUNCTION OF THE SCHOOL AND THE CREST VERSION, and that is the property
 * that matters. `logoUpdatedAt` moves only when the crest BYTES move, so a
 * school fixing a typo in its motto produces the identical URL, the identical
 * /api/student/sync body, the identical ETag, a 304, and no device store write
 * at all. Keying on ResultPeak's `updatedAt` instead would rewrite every child's
 * store on every save of anything.
 *
 * `0` is the version every school carries today and it is a legitimate value,
 * never "unknown": a crest can only change through a profile save and that save
 * stamps the field, so 0 cannot describe two different pictures for one school
 * over time.
 */
export function crestUrlFor(schoolId: string, logoUpdatedAt: number): string {
  const version = Number.isFinite(logoUpdatedAt) ? Math.trunc(logoUpdatedAt) : 0;
  return `/api/schools/${encodeURIComponent(schoolId)}/logo?v=${version}`;
}

/** Crest bytes decoded from a data URI, ready to serve. */
export interface DecodedCrest {
  body: Buffer;
  contentType: string;
}

/**
 * Split a `data:image/...;base64,...` URI into bytes and a content type.
 *
 * Returns null for anything else, an https URL included, so the caller 404s
 * rather than serving something it did not parse. An https crest is NOT fetched
 * and proxied: fetching an arbitrary URL out of a Firestore document,
 * server-side, would be a request-forgery primitive aimed at whatever an admin
 * typed into another product's form.
 *
 * The content type comes out of the URI and is checked against CREST_TYPES by
 * the route, never trusted from here. That check decides what a browser will
 * execute.
 */
export function decodeCrestDataUri(value: unknown): DecodedCrest | null {
  const raw = String(value ?? "").trim();
  if (!isSafeCrestUrl(raw)) return null;

  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(raw);
  if (!match) return null;

  const [, contentType, base64] = match;
  try {
    const body = Buffer.from(base64, "base64");
    if (!body.length) return null;
    return { body, contentType: contentType.toLowerCase() };
  } catch {
    return null;
  }
}
