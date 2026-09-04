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
