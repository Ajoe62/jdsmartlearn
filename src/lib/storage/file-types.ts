/**
 * File-type constants safe to import from a client component.
 *
 * Deliberately NOT in provider.ts: that module is `server-only`, because it
 * reaches the storage SDK and the credentials. The tutor's forms and the
 * student's submission form need the lists of extensions and the size caps, and
 * a list of strings is not a reason to pull the storage layer into the browser
 * bundle.
 *
 * ONE definition of every limit, used by the form that warns and the route that
 * enforces. Two copies of a limit means a client that cheerfully accepts what
 * the server then refuses, and the person who finds out is the one on the slow
 * connection who already waited for the upload.
 */

/** Who is uploading, and into what. Decides the allowlist and the size cap. */
export type UploadPurpose = "lesson" | "scheme" | "assignment" | "submission";

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
 * What a tutor may upload as the ORIGINAL of a lesson, a scheme of work, or an
 * assignment's question sheet.
 *
 * Wider than SUBMITTABLE_TYPES on purpose. A student's attachment is graded, so
 * it is held to what the grading path can read. A tutor's original is stored and
 * opened, and a school's scheme of work arrives as whatever the head teacher
 * typed it in: old Word, PowerPoint, Excel, or a photo of a printed page. Text is
 * read from the types in READABLE_TYPES; the rest are kept as the original, which
 * is what a student opens.
 *
 * Deliberately NOT "any file". No programs or scripts (they would land on a
 * child's phone), no web pages or SVG (they can carry script), and no audio or
 * video (video delivery is out of scope for v1 - CLAUDE.md).
 */
export const TUTOR_UPLOAD_TYPES = [
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".txt",
  ".jpg",
  ".jpeg",
  ".png",
] as const;

/** The same list, in the words a teacher uses. Keep the two in step. */
export const TUTOR_UPLOAD_LABEL = "PDF, Word, PowerPoint, Excel, text or a photo";

/** Extensions the server reads text out of. Everything else is kept as the original only. */
export const READABLE_TYPES = [".pdf", ".doc", ".docx", ".txt"] as const;

/**
 * The largest single file a tutor may upload. Decided by the owner on
 * 2026-09-11: big enough for a scanned textbook chapter or a slide deck, small
 * enough that R2's 10 GB free tier holds a school's year of originals.
 *
 * Only possible because bytes go from the browser straight to R2. A Vercel
 * function refuses any request over 4.5 MB, which is why the old 10 MB limit
 * was a lie for everything between the two.
 */
export const MAX_TUTOR_FILE_BYTES = 100 * 1024 * 1024;

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
 * How much a student may attach.
 *
 * Raised from 5 MB to 20 MB on 2026-09-11, when attachments stopped passing
 * through a Vercel function (whose 4.5 MB body limit made the old 5 MB
 * unreachable anyway). Photos are shrunk on the phone before they upload, so the
 * common case is well under 1 MB; the headroom is for a scanned PDF.
 */
export const MAX_SUBMISSION_FILES = 3;
export const MAX_SUBMISSION_FILE_BYTES = 20 * 1024 * 1024;

export function uploadTypesFor(purpose: UploadPurpose): readonly string[] {
  return purpose === "submission" ? SUBMITTABLE_TYPES : TUTOR_UPLOAD_TYPES;
}

export function maxBytesFor(purpose: UploadPurpose): number {
  return purpose === "submission" ? MAX_SUBMISSION_FILE_BYTES : MAX_TUTOR_FILE_BYTES;
}

/** "100 MB". Whole megabytes; every cap here is one. */
export function formatLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The `accept` attribute for a file input. A hint to the picker, never a control. */
export function acceptAttr(types: readonly string[]): string {
  return types.join(",");
}

/**
 * The extension of a filename, lowercased, with its dot. Empty when there is none.
 *
 * Takes the LAST dot, so "answer.pdf.exe" is ".exe" and not ".pdf". A check on
 * the first extension would accept a name chosen to look like a PDF.
 */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const slash = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  return dot <= 0 || dot < slash ? "" : fileName.slice(dot).toLowerCase();
}

export function isReadableType(fileName: string): boolean {
  return (READABLE_TYPES as readonly string[]).includes(extensionOf(fileName));
}

/** Whether a browser shows this type itself rather than downloading it. */
export function inlineable(mime: string | null | undefined): boolean {
  const t = mime ?? "";
  return t.startsWith("application/pdf") || t.startsWith("text/") || t.startsWith("image/");
}

const MAX_NAME = 150;

/**
 * A display name safe to store and to put in a download header.
 *
 * The name is the uploader's, so it is data, not a path: only the last segment
 * survives, control characters go, and the extension is forced to the one the
 * server chose the storage key by. A name that claims ".pdf" over bytes stored
 * as ".docx" would open in the wrong program on a child's phone.
 */
export function cleanFileName(raw: unknown, ext: string): string {
  const text = typeof raw === "string" ? raw : "";
  const last = text.split(/[/\\]/).pop() ?? "";
  let name = last.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (extensionOf(name) !== ext) name = `${name || "file"}${ext}`;
  if (name.length > MAX_NAME) {
    name = `${name.slice(0, MAX_NAME - ext.length).trimEnd()}${ext}`;
  }
  return name === ext ? `file${ext}` : name;
}

/**
 * Whether a tutor may upload this file, and what to tell them if not. Null when
 * it is acceptable. The picker calls this before a byte moves; the server
 * applies the same caps again when it hands out the upload address and when it
 * claims the upload.
 */
export function rejectTutorUpload(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `${file.name} is empty. Choose another file.`;
  if (file.size > MAX_TUTOR_FILE_BYTES) {
    return `${file.name} is larger than ${formatLimit(MAX_TUTOR_FILE_BYTES)}. Use a smaller file, or split it in two.`;
  }
  if (!(TUTOR_UPLOAD_TYPES as readonly string[]).includes(extensionOf(file.name))) {
    return `${file.name} can't be uploaded. Use a ${TUTOR_UPLOAD_LABEL}.`;
  }
  return null;
}

/**
 * Whether a student may attach this file, and what to tell them if not.
 *
 * THE SERVER IS THE CONTROL, and this is the function it calls. The `accept`
 * attribute on the file input is a hint: it filters the picker on the phones
 * that honour it, and it stops nothing. A crafted request, a drag and drop on a
 * browser that ignores `accept`, or a queued offline submission replayed later
 * all arrive without it having applied.
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
    return `${file.name} is too large. Each file must be under ${formatLimit(MAX_SUBMISSION_FILE_BYTES)}.`;
  }
  const ext = extensionOf(file.name);
  const submittable = (SUBMITTABLE_TYPES as readonly string[]).includes(ext);
  const allowed = resolveAllowedFileTypes(configured).includes(ext);
  if (!submittable || !allowed) {
    return `${file.name} is not a file type your teacher accepts.`;
  }
  return null;
}
