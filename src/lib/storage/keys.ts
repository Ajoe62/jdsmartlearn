/**
 * How an object's key is built, in one place.
 *
 * NOT `server-only`, deliberately: these are pure string builders with no SDK
 * behind them, and the tests assert their shape directly. Reading and writing
 * the bytes still goes through storage/provider.ts and nowhere else.
 *
 * EVERY KEY STARTS WITH THE SCHOOL, and that is the whole point of this file.
 * A school purge deletes objects by the key stored on each document, so the
 * prefix is not how deletion finds them - it is how deletion can be CHECKED
 * afterwards. Without it there is no prefix to list and confirm a departed
 * school's files are gone, and "we deleted it" is a claim made to schools in
 * writing. See docs/resultpeak-deletion-protocol-prompt.md and the
 * `prefixedBySchool` flag in db/purge-plan.ts.
 *
 * HISTORIC LESSON KEYS ARE `lessons/{lessonId}/original{ext}`, with no school,
 * written before that was understood. They are left exactly as they are: the
 * key is always read from the lesson document, never rebuilt from parts, so an
 * old object is fetched and deleted correctly and there is nothing to migrate.
 * The prefix arrives on new uploads, and the gap closes on its own.
 */

/** Everything this product stores for one school sits under this prefix. */
export function schoolPrefix(schoolId: string): string {
  return `${schoolId}/`;
}

/** The original file a tutor uploaded for a lesson. `ext` includes the dot. */
export function lessonFileKey(schoolId: string, lessonId: string, ext: string): string {
  return `lessons/${schoolId}/${lessonId}/original${ext}`;
}

/** A scheme of work uploaded for a (class, subject). */
export function schemeFileKey(schoolId: string, schemeId: string, ext: string): string {
  return `schemes/${schoolId}/${schemeId}${ext}`;
}

/** An assignment's question sheet. One per assignment. */
export function assignmentFileKey(schoolId: string, assignmentId: string, ext: string): string {
  return `assignments/${schoolId}/${assignmentId}/sheet${ext}`;
}

/**
 * Where a browser puts bytes before any document points at them.
 *
 * Uploads go straight from the phone to R2 on a presigned address, because a
 * Vercel function refuses any request over 4.5 MB. The server cannot vouch for
 * those bytes until a route CLAIMS them - checks the owner, the size and the
 * type, then copies them to the permanent key built by the functions above. So
 * they land here first, under the school and the uploader.
 *
 * An upload that is never claimed - a tutor who closed the tab - is litter, and
 * the bucket's lifecycle rule deletes everything under this prefix after a day
 * (docs/r2-bucket-setup.md). Nothing needs a Firestore record of it.
 *
 * `actorId` is namespaced (`t-{uid}` or `s-{studentId}`) so a tutor uid and a
 * student id can never name the same folder.
 */
export const STAGING_PREFIX = "uploads/";

export function stagingKey(schoolId: string, actorId: string, token: string, ext: string): string {
  return `${STAGING_PREFIX}${schoolId}/${actorId}/${token}${ext}`;
}

const TOKEN_AND_EXT = /^[A-Za-z0-9]{16,64}\.[a-z0-9]{1,5}$/;

/**
 * Whether `key` is a staging key written by THIS actor in THIS school.
 *
 * The only thing standing between a crafted request and claiming somebody
 * else's upload, so it is strict: the exact prefix, then a single segment of
 * token and extension with no slash left to smuggle a path through.
 */
export function ownsStagingKey(key: string, schoolId: string, actorId: string): boolean {
  if (!schoolId || !actorId || schoolId.includes("/") || actorId.includes("/")) return false;
  const prefix = stagingKey(schoolId, actorId, "", "");
  if (!key.startsWith(prefix)) return false;
  return TOKEN_AND_EXT.test(key.slice(prefix.length));
}

/** One attachment on a student's submission, numbered in upload order. */
export function submissionAttachmentKey(
  schoolId: string,
  assignmentId: string,
  studentId: string,
  index: number,
  ext: string
): string {
  return `submissions/${schoolId}/${assignmentId}/${studentId}/${index}${ext}`;
}
