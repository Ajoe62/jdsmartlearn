/**
 * The student passport photo, as an address. Client-safe: no Firestore, no
 * Buffer, so the dashboard can import it without growing the student bundle.
 *
 * The photo is ResultPeak's (`studentPhotos/{studentId}`). This repo stores no
 * copy and has no upload path - see CLAUDE.md, Student photo rules.
 */

export const PHOTO_PATH = "/api/student/photo";

/**
 * The service worker bucket that holds this student's own photo, and nothing
 * else. Its own bucket rather than the shell's, so every wipe can drop it by
 * name - including `wipeContent()`, which clears IndexedDB and would otherwise
 * leave a previous child's face in the Cache API.
 */
export const PHOTO_CACHE = "jd-photo-v1";

/**
 * `students/{id}.photoUpdatedAt` as epoch milliseconds, or null for "no photo".
 *
 * ResultPeak writes a Firestore Timestamp. Anything else it could plausibly
 * become - a Date, a number, an ISO string, a Timestamp that went through JSON -
 * is accepted too, because a field on another product's document can change
 * shape without anybody here being told, and the failure must be "no photo",
 * never a thrown sign-in.
 */
export function photoVersion(value: unknown): number | null {
  let ms: number | null = null;

  if (typeof value === "number") ms = value;
  else if (typeof value === "string") ms = Date.parse(value);
  else if (value instanceof Date) ms = value.getTime();
  else if (value && typeof value === "object") {
    const v = value as {
      toMillis?: () => number;
      seconds?: number;
      _seconds?: number;
      nanoseconds?: number;
      _nanoseconds?: number;
    };
    if (typeof v.toMillis === "function") ms = v.toMillis();
    else {
      const s = v.seconds ?? v._seconds;
      const n = v.nanoseconds ?? v._nanoseconds ?? 0;
      if (typeof s === "number") ms = s * 1000 + Math.floor(n / 1e6);
    }
  }

  return ms !== null && Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : null;
}

/**
 * Our own route, versioned by `photoUpdatedAt` so a newly approved photo is a
 * URL the phone has never seen, and nothing ever needs invalidating.
 *
 * The student id is IN the URL although the route takes the student from the
 * session. It makes each child's photo a different cache key, so on a shared
 * phone one child's saved photo can never answer for another's - even in the
 * moment before a wipe finishes. The route 404s when it disagrees with the
 * session, so it grants nothing.
 */
export function studentPhotoUrl(studentId: string, version: number): string {
  return `${PHOTO_PATH}?s=${encodeURIComponent(studentId)}&v=${Math.trunc(version)}`;
}
