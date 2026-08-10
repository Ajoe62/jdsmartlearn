/**
 * File-type constants safe to import from a client component.
 *
 * Deliberately NOT in provider.ts: that module is `server-only`, because it
 * reaches the storage SDK and the credentials. The tutor's assignment form needs
 * the list of extensions a student may attach, and a list of strings is not a
 * reason to pull the storage layer into the browser bundle.
 */

/**
 * Extensions a student may attach to a submission.
 *
 * ONE list, and it is the union of what the grading path can actually read:
 * `src/lib/extract/text.ts` handles .pdf, .docx and .txt, and images go to the
 * provider's vision path. Adding an extension here without an extractor would
 * offer a tutor a type that then grades as an empty answer.
 */
export const SUBMITTABLE_TYPES = [
  ".pdf",
  ".docx",
  ".txt",
  ".jpg",
  ".jpeg",
  ".png",
] as const;

export type SubmittableType = (typeof SUBMITTABLE_TYPES)[number];

/**
 * What an assignment accepts when it never said.
 *
 * `Assignment.allowedFileTypes` is `string[] | null`, and the two are NOT the
 * same thing:
 *
 *   null  the tutor never chose, so accept anything a student can hand in
 *   []    the tutor chose nothing, so typed answers only
 *
 * Assignments written before the field existed read back as null, and so does a
 * request that omits it. Neither should mean "no attachments" - a student would
 * be refused a photo of their exercise book with no tutor having decided that.
 */
export const DEFAULT_ALLOWED_FILE_TYPES: readonly string[] = SUBMITTABLE_TYPES;

/**
 * The concrete list to enforce and to show, from what the document stored.
 *
 * Used by BOTH sides of the check - the submit route's validation and the form
 * that tells a student what to attach - so the two cannot disagree about what a
 * missing value means.
 */
export function resolveAllowedFileTypes(
  configured: readonly string[] | null | undefined
): string[] {
  // An empty array is a real answer, so test for absence, not for emptiness.
  return configured ? [...configured] : [...DEFAULT_ALLOWED_FILE_TYPES];
}
