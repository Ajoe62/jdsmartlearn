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

/**
 * How much a student may attach. ONE definition for both sides.
 *
 * These were two pairs of constants, one in `SubmissionForm` and one in the
 * submit route. Two copies of a limit means a client that cheerfully accepts
 * what the server then refuses, and the child who finds out is the one on the
 * slow connection who already waited for the upload.
 */
export const MAX_SUBMISSION_FILES = 3;
export const MAX_SUBMISSION_FILE_BYTES = 5 * 1024 * 1024;

/**
 * The extension of a filename, lowercased, with its dot. Empty when there is none.
 *
 * Takes the LAST dot, so "answer.pdf.exe" is ".exe" and not ".pdf". A check on
 * the first extension would accept a name chosen to look like a PDF.
 */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot).toLowerCase();
}

/**
 * Whether a student may attach this file, and what to tell them if not.
 *
 * THE SERVER IS THE CONTROL, and this is the function it calls. The `accept`
 * attribute on the file input is a hint: it filters the picker on the phones
 * that honour it, and it stops nothing. A crafted multipart request, a drag and
 * drop on a browser that ignores `accept`, or a queued offline submission
 * replayed later all arrive without it having applied.
 *
 * Returns null when the file is acceptable, otherwise the message to show. The
 * message names the file, because a student attaching three things needs to know
 * which one to replace.
 *
 * TWO gates, and both must pass:
 *
 *  1. `SUBMITTABLE_TYPES`, what the product can read at all. A tutor cannot
 *     widen this by ticking a box, because there is no extractor behind it.
 *  2. The assignment's own list, resolved so a null means the default rather
 *     than nothing.
 */
export function rejectAttachment(
  file: { name: string; size: number },
  configured: readonly string[] | null | undefined
): string | null {
  if (file.size > MAX_SUBMISSION_FILE_BYTES) {
    return `${file.name} is too large. Each file must be under 5 MB.`;
  }
  const ext = extensionOf(file.name);
  const submittable = (SUBMITTABLE_TYPES as readonly string[]).includes(ext);
  const allowed = resolveAllowedFileTypes(configured).includes(ext);
  if (!submittable || !allowed) {
    return `${file.name} is not a file type your teacher accepts.`;
  }
  return null;
}
