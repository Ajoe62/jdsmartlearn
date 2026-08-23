/**
 * Scheme of work: the curriculum outline a tutor uploads for a (class, subject).
 *
 * SEPARATE FROM `Lesson`, and the separation is the point. A scheme has no AI
 * generation, no practice questions, no marking guide, no study-guide status
 * machine, and its own single publish switch. Folding it into `lessons` would
 * put five unused fields on every lesson and a `kind` check on every query that
 * reads one. What it DOES share - R2 storage, text extraction, the authenticated
 * file route - it shares by calling the same modules.
 *
 * Conventions inherited from types/index.ts: epoch milliseconds never Firestore
 * Timestamps, `null` never `undefined` for a value not yet set, display strings
 * denormalized at write time.
 */

/** One row of a term's outline. Optional - most schools upload a document. */
export interface SchemeWeek {
  /** 1-based. A Nigerian term runs 12 to 14 weeks. */
  week: number;
  topic: string;
}

export interface Scheme {
  id: string;
  schoolId: string;
  classId: string;
  /** Denormalized so a list renders without reading ResultPeak's classes. */
  className: string;
  subjectId: string;
  /** Denormalized from schools/{id}.subjects[] at write time. */
  subjectName: string;
  tutorId: string;

  /**
   * ResultPeak's strings, copied byte for byte at creation and never resolved
   * again - the same rule as Lesson and Assignment. A scheme IS a term's plan,
   * so unlike a lesson these are the point of the document rather than metadata,
   * and the composer requires them.
   *
   * Still nullable, because a school admin may not have set the current term
   * when the first tutor uploads. Such a scheme shows under "Earlier" and is
   * never guessed into a term from its upload date.
   */
  term: string | null;
  session: string | null;

  title: string;
  /** Extracted text - the readable default on a slow network, as for lessons. */
  extractedText: string;
  /** Optional structured outline the tutor typed instead of, or beside, a file. */
  weeks: SchemeWeek[];

  /** Original uploaded file in R2. Absent for a typed-only scheme. */
  fileKey?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;

  /**
   * When this was published to students. `null` while it is a draft.
   *
   * ONE switch, unlike a lesson's two. A lesson separates raw material from the
   * AI study guide because the guide needs review before a child sees it. A
   * scheme has no generated half, so there is nothing to review separately and a
   * second switch would be a control with no meaning behind it.
   */
  publishedAt: number | null;

  createdAt: number;
  updatedAt: number;
}

/**
 * What a student receives.
 *
 * Names its fields rather than spreading `Scheme`, the same rule as
 * `toStudentPayload` and `toStudentAssignment`. `tutorId` and `fileKey` have no
 * field here to occupy - the first is a uid a child must never be shown, the
 * second is an R2 object key, and a key on a client payload is a public bucket
 * URL by another name.
 */
export interface StudentScheme {
  schemeId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  term: string | null;
  session: string | null;
  text: string;
  weeks: SchemeWeek[];
  /** Present only when a file was uploaded. `href` is a same-origin route. */
  file: { name: string; size: number; inline: boolean } | null;
  updatedAt: number;
}

/** The index projection: everything except the body. What a shelf row needs. */
export type StudentSchemeSummary = Omit<StudentScheme, "text" | "weeks"> & {
  hasWeeks: boolean;
};
