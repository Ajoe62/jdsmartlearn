/**
 * Assessment domain types: assignments, submissions, AI grading, progress, and
 * the record shared with ResultPeak.
 *
 * Conventions inherited from types/index.ts, not restated per field:
 *
 *  - **Times are epoch milliseconds, never Firestore `Timestamp`.** A Timestamp
 *    object does not survive the server/client boundary in the App Router, does
 *    not store in IndexedDB, and does not hash into the sync ETag. Every
 *    existing JD document already uses `number`.
 *  - **Missing values are `null`, never `undefined`**, so a field that has not
 *    been filled in yet reads the same from Firestore, from IndexedDB and from a
 *    server component prop. The one exception is a field whose *absence* is the
 *    signal (see `studentPayload` on Lesson), and there is no such field here.
 *  - **Denormalize display strings** (subject name, class name, topic title) at
 *    write time. A list view must cost one query, not one plus N.
 */

import type { AcademicSession, AcademicTerm } from "@/lib/academic-calendar";

/**
 * Term and session are `string`, never a number and never an enum.
 *
 * They are ResultPeak's values, copied byte for byte, because ResultPeak joins a
 * result sheet on the literal strings. Nothing in this codebase may trim, case
 * fold, or otherwise reshape them, and there is no number-to-name mapping table
 * anywhere. See `src/lib/academic-calendar.ts`.
 *
 * Not to be confused with `Term` in `types/index.ts`, which is the 1 | 2 | 3
 * used by curriculum `topics`. That one is JDSmartLearn's own, is seeded from
 * `seed/topics/`, and never takes part in a ResultPeak join.
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type AssignmentType = "written" | "project" | "holiday" | "practical";

export const ASSIGNMENT_TYPES: AssignmentType[] = [
  "written",
  "project",
  "holiday",
  "practical",
];

/** Tutor-facing labels. Sentence case, plain nouns (CLAUDE.md, Interface writing). */
export const ASSIGNMENT_TYPE_LABELS: Record<AssignmentType, string> = {
  written: "Written",
  project: "Project",
  holiday: "Holiday",
  practical: "Practical",
};

/**
 * Submission lifecycle.
 *
 *   submitted          student sent it, grading not started
 *   ai_grading         grading route is running
 *   ai_graded          AI result stored, NOT visible to the student yet
 *   ai_grading_failed  two attempts failed; flagged for manual marking
 *   teacher_reviewed   tutor saved a draft mark without releasing
 *   finalised          released to the student, score counted toward CA
 *
 * Only `finalised` is student-visible as a score. Teacher review before release
 * is mandatory, exactly as it is for generated lesson content (CLAUDE.md, AI rules).
 */
export type SubmissionStatus =
  | "submitted"
  | "ai_grading"
  | "ai_graded"
  | "ai_grading_failed"
  | "teacher_reviewed"
  | "finalised";

/** Statuses the student's "Submitted" tab shows. Graded means finalised only. */
export const IN_PROGRESS_STATUSES: SubmissionStatus[] = [
  "submitted",
  "ai_grading",
  "ai_graded",
  "ai_grading_failed",
  "teacher_reviewed",
];

export type AIConfidence = "high" | "medium" | "low";

/** Which tab the student assignment list is showing. Mirrors `?tab=`. */
export type AssignmentTab = "pending" | "submitted" | "graded";

export const ASSIGNMENT_TABS: AssignmentTab[] = ["pending", "submitted", "graded"];

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * An attachment as stored on a submission document.
 *
 * `key` is an R2 object key, NOT a URL. A URL on the document is a public bucket
 * URL by another name; CLAUDE.md permits file access only through an
 * authenticated route that re-checks schoolId and class scope on every request.
 * The route mints access at read time from this key.
 */
export interface SubmissionAttachment {
  name: string;
  key: string;
  /** MIME type as uploaded, used to pick the extractor during grading. */
  type: string;
  size: number;
}

/**
 * What the client is handed instead of a key: a name to show and a path on this
 * origin to fetch. Never a bucket URL.
 */
export interface AttachmentLink {
  name: string;
  type: string;
  size: number;
  /** Same-origin authenticated route, e.g. `/api/.../attachments/{index}`. */
  href: string;
}

/**
 * A piece of work set for one class.
 *
 * FULL shape, tutor-side only. `markingGuide` is on this interface, so this type
 * must never be returned from a student route. Project it through
 * `toStudentAssignment()` first, which yields `StudentAssignment` below.
 */
export interface Assignment {
  id: string;
  schoolId: string;
  classId: string;
  /** Denormalized so a list renders without reading ResultPeak's classes. */
  className: string;
  subjectId: string;
  /** Denormalized from schools/{id}.subjects[] at write time. */
  subjectName: string;
  tutorId: string;
  title: string;
  description: string;
  type: AssignmentType;
  /** Epoch ms. Compared against Date.now() plus the grace window on submit. */
  dueDate: number;
  maxMarks: number;
  /**
   * TUTOR-ONLY. The AI grades against this, and a student must never see it.
   * Same rule as GeneratedContent.markingGuide (CLAUDE.md, Security rule 4).
   */
  markingGuide: string;
  /** Published lesson this assignment follows from, when the tutor picked one. */
  linkedLessonId: string | null;
  /**
   * Extensions a student may attach, e.g. ".pdf". THREE distinct values:
   *
   *   ["…"]  exactly these
   *   []     the tutor ticked nothing, so typed answers only
   *   null   the tutor never chose, so DEFAULT_ALLOWED_FILE_TYPES applies
   *
   * An assignment written before this field existed carries no value at all,
   * which resolves the same way as null and is why every read goes through the
   * helper. Resolve with `resolveAllowedFileTypes()` rather than `?? []`,
   * which would silently refuse a photo no tutor decided to refuse. An
   * assignment still degrades to text only when R2 credentials are absent, but
   * that is decided by `storageConfigured()`, not by this field.
   */
  allowedFileTypes: string[] | null;
  /**
   * FROZEN AT CREATION, both of them. Prefilled from the school setting, then
   * stored on this document and never resolved again.
   *
   * The current term moves. An assignment created in first term must still
   * report first term when it is read in third term, so no read path may ask
   * what the current term is. See `db/school-settings.ts`.
   */
  term: AcademicTerm;
  session: AcademicSession;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Safe projection of an assignment for a student device.
 *
 * Built ONLY by `toStudentAssignment()`, which names each field rather than
 * spreading `Assignment`, so `markingGuide` cannot be copied in by accident.
 * This shape has no field it could occupy. Same defence as StudentPayload.
 */
export interface StudentAssignment {
  assignmentId: string;
  title: string;
  description: string;
  subjectId: string;
  subjectName: string;
  type: AssignmentType;
  dueDate: number;
  maxMarks: number;
  linkedLessonId: string | null;
  /**
   * ALREADY RESOLVED, never null: `toStudentAssignment()` applies the default,
   * so no student surface and no device store has to know what null meant.
   */
  allowedFileTypes: string[];
  /** Bumped whenever the tutor edits, so a device knows its copy is stale. */
  revision: number;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * One student's answer to one assignment.
 *
 * `schoolId`, `assignmentId`, `classId`, `subjectId`, `term` and `session` are
 * denormalized onto every submission. They are not decoration:
 *
 *  - `schoolId` is the tenant spine, and CLAUDE.md requires it in the filter of
 *    every query;
 *  - `subjectId`, `term` and `session` together make the running CA average an
 *    equality-only query, which keeps this repo free of composite indexes;
 *  - `assignmentId` is how a flat document names its parent at all, since the
 *    collection is top-level rather than nested under the assignment.
 *
 * `term` and `session` are COPIED FROM THE PARENT ASSIGNMENT at submission time,
 * never from the current school setting. The setting moves; this must not.
 */
export interface AssignmentSubmission {
  /** Deterministic: `${assignmentId}_${studentId}`. One submission per student. */
  id: string;
  schoolId: string;
  assignmentId: string;
  studentId: string;
  classId: string;
  subjectId: string;
  /** Copied verbatim from the assignment. Never resolved at read time. */
  term: AcademicTerm;
  session: AcademicSession;
  /**
   * The tutor who set the assignment. Denormalized so the security rule that
   * lets a tutor read submissions on their own assignment is a field comparison,
   * not a `get()` on the parent, which would bill a read per document evaluated.
   */
  tutorId: string;
  /** Denormalized for the tutor table and the student list card. */
  assignmentTitle: string;
  subjectName: string;
  maxMarks: number;

  submittedAt: number;
  content: string;
  attachments: SubmissionAttachment[];
  status: SubmissionStatus;

  /**
   * How many times this has been sent for marking, INCLUDING the attempt made at
   * submission time. Capped, so a submission that fails deterministically stops
   * spending the school's shared Gemini quota. See lib/assessment/grading-recovery.
   */
  gradingAttempts: number;
  /** When marking was last attempted. The clock the stuck sweep measures from. */
  lastGradingAttemptAt: number;

  // ----- AI result. All null until the grading route has run. -----
  aiScore: number | null;
  aiMaxScore: number | null;
  aiConfidence: AIConfidence | null;
  aiFeedback: string | null;
  aiStrengths: string[] | null;
  aiImprovements: string[] | null;
  topicsMastered: string[] | null;
  topicsToRevise: string[] | null;

  // ----- Teacher result. The tutor may override the AI entirely. -----
  teacherScore: number | null;
  teacherComment: string | null;

  /** Teacher score when the tutor gave one, otherwise the AI score. */
  finalScore: number | null;
  finalisedAt: number | null;

  /**
   * Guards an offline-queued mark against a submission that moved on while the
   * tutor was away. Routes return 409 when this does not match, same contract as
   * the lesson patch and publish routes.
   */
  updatedAt: number;
}

/**
 * Safe projection of a submission for a student device.
 *
 * Built ONLY by `toStudentSubmissionPayload()`. Carries no marking guide, no
 * tutor id, and no AI fields at all until the tutor finalises. Before that, a
 * student sees status text and nothing more.
 */
export interface StudentSubmissionView {
  assignmentId: string;
  assignmentTitle: string;
  subjectName: string;
  submittedAt: number;
  status: SubmissionStatus;
  content: string;
  attachments: AttachmentLink[];
  maxMarks: number;

  /** Everything below is null unless status is "finalised". */
  finalScore: number | null;
  finalisedAt: number | null;
  feedback: string | null;
  strengths: string[] | null;
  improvements: string[] | null;
  topicsToRevise: TopicLink[] | null;
  topicsMastered: string[] | null;
  teacherComment: string | null;
}

/**
 * A topic to revise, resolved to a lesson when one in the same subject matches
 * by title. `lessonId` stays null when nothing matches, and the interface then
 * renders plain text rather than a dead link.
 */
export interface TopicLink {
  topic: string;
  lessonId: string | null;
}

// ---------------------------------------------------------------------------
// AI grading
// ---------------------------------------------------------------------------

/**
 * Validated output of one grading call. Shape mirrors GenerationResult: the Zod
 * schema is the boundary, and nothing downstream trusts a raw model response.
 *
 * `score` is bounded by the schema AND clamped again after parsing. Two checks,
 * because a model that returns 40 out of 25 would otherwise inflate a real
 * child's continuous assessment.
 */
export interface AIGradingResult {
  score: number;
  confidence: AIConfidence;
  feedback: string;
  strengths: string[];
  improvements: string[];
  topicsMastered: string[];
  topicsToRevise: string[];
}

/**
 * What the grading route sends the provider. Carries lesson-shaped content only.
 *
 * NEVER add a student name, student id, tutor name, or school name. The free
 * tier permits the provider to use submitted content, so treat this object as
 * third-party readable (CLAUDE.md, Security rule 1).
 */
export interface GradingPromptInput {
  assignmentTitle: string;
  subjectName: string;
  markingGuide: string;
  maxMarks: number;
  submissionText: string;
}

/**
 * Provider model hint. The provider resolves this to a concrete variant; callers
 * never name a model, so swapping one stays a single-file change.
 */
export type ModelHint = "fast" | "quality";

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * One student's standing in one subject.
 *
 * Flat document keyed `${schoolId}_${studentId}_${subjectId}`, no subcollection.
 * A deterministic id means every update is a single `set(..., { merge: true })`
 * with no read first, and the progress page is one equality-only query.
 */
export interface StudentProgress {
  id: string;
  schoolId: string;
  studentId: string;
  subjectId: string;
  /** Denormalized so the progress page reads no ResultPeak documents. */
  subjectName: string;
  lessonsViewed: number;
  assignmentsSubmitted: number;
  assignmentsGraded: number;
  /** Percentage across finalised submissions. Null until the first is released. */
  averageScore: number | null;
  topicsMastered: string[];
  topicsToRevise: string[];
  lastUpdated: number;
}

/** The progress page's per-subject card, assembled server-side from the above. */
export interface SubjectProgressCard {
  subjectId: string;
  subjectName: string;
  lessonsViewed: number;
  /** Published lessons available to this class in this subject. */
  lessonsAvailable: number;
  assignmentsSubmitted: number;
  assignmentsGraded: number;
  averageScore: number | null;
  /**
   * Read-only mirror of what JDSmartLearn last synced to ResultPeak, for the
   * assessment type this school mapped. Null when the mapping is unset, when the
   * type has since been removed, or when nothing has been released yet.
   */
  continuousAssessment: number | null;
  topicsMastered: string[];
  topicsToRevise: TopicLink[];
}

// ---------------------------------------------------------------------------
// The shared record
// ---------------------------------------------------------------------------

/**
 * The one document both platforms write, keyed `${schoolId}_${studentId}`.
 *
 * FIELD OWNERSHIP IS THE WHOLE CONTRACT. Neither platform owns the document, so
 * neither may write it wholesale. There is no merge negotiation and no
 * last-writer-wins recovery: a `set()` without merge from either side destroys
 * the other side's marks.
 *
 *   JDSmartLearn writes ONLY  continuousAssessment.{subjectId}, lastUpdatedByLMS
 *   ResultPeak    writes ONLY  examScore.{subjectId},            lastUpdatedByAssessment
 *
 * Enforced at runtime by `assertRecordFields()`, which rejects any update whose
 * key set, including dotted field paths, falls outside the LMS half. Reading the
 * ResultPeak half is fine and is what the progress page does.
 */
export interface StudentAcademicRecord {
  id: string;
  schoolId: string;
  studentId: string;

  /**
   * WRITTEN BY JDSMARTLEARN. `subjectId` to `assessmentTypeId` to percentage.
   *
   *   continuousAssessment["biology"]["first_assessment"] = 72
   *
   * NESTED, because ResultPeak does not model continuous assessment as one
   * number per subject. It models several named components per subject, chosen
   * per school, each with its own max: CAPSTONE runs first_assessment(20),
   * second_assessment(20), exam(60); HIGHER GROUND runs six including
   * h_assignment and project. A single blended number could never be placed in
   * any of those columns.
   *
   * The key is the assessment type's stable `value` from
   * `schools/{id}.assessmentTypes`, e.g. "first_assessment". It IS stable:
   * ResultPeak's own `matchAssessmentType()` matches strictly on it and returns
   * null rather than substituting.
   *
   * VALUES ARE PERCENTAGES, 0 to 100. Never raw marks. ResultPeak owns each
   * component's `maxScore`, so ResultPeak scales the percentage when it folds
   * this into its own records. JDSmartLearn does not do that arithmetic, because
   * a max it cached could be edited on the school document an hour later.
   */
  continuousAssessment: Record<string, Record<string, number>>;
  /** WRITTEN BY JDSMARTLEARN. */
  lastUpdatedByLMS: number | null;

  /** WRITTEN BY RESULTPEAK. Read-only here. Never write this field. */
  examScore: Record<string, number>;
  /** WRITTEN BY RESULTPEAK. Read-only here. Never write this field. */
  lastUpdatedByAssessment: number | null;
}

/**
 * The runtime allowlist lives in `lib/db/collections.ts` as
 * `LMS_WRITABLE_RECORD_FIELDS`, not here: the scripts import that module by
 * relative path and cannot resolve the `@/` alias. One source of truth.
 */
export type { LMSWritableRecordField } from "@/lib/db/collections";

// ---------------------------------------------------------------------------
// List projections
// ---------------------------------------------------------------------------

/**
 * One row in the student's assignment list, across all three tabs.
 *
 * Assembled entirely from denormalized fields already on the assignment and the
 * submission, so a tab renders from one query and never fans out. This is also
 * the exact shape cached in the device's `assignments` object store, which is
 * why it carries no marking guide and no tutor id.
 */
export interface AssignmentListItem {
  assignmentId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  type: AssignmentType;
  dueDate: number;
  maxMarks: number;
  /** Null on the Pending tab, where by definition no submission exists. */
  status: SubmissionStatus | null;
  submittedAt: number | null;
  /** Set only once the tutor has finalised. */
  finalScore: number | null;
  /** finalScore over maxMarks as a whole percentage, or null. */
  percentage: number | null;
  /** dueDate is in the past and nothing has been submitted. */
  isOverdue: boolean;
}

/**
 * One row in the tutor's submission table.
 *
 * Carries the student's sign-in username, never their name. The tutor already
 * has names in ResultPeak; repeating them here would put personal data into a
 * JDSmartLearn surface for no gain, and the sign-in cards set the precedent
 * (CLAUDE.md, Security rule 6).
 */
export interface TutorSubmissionRow {
  submissionId: string;
  studentId: string;
  /** From studentLogins, e.g. "jss3-04". Null if no alias has been issued yet. */
  username: string | null;
  submittedAt: number;
  status: SubmissionStatus;
  aiScore: number | null;
  aiConfidence: AIConfidence | null;
  teacherScore: number | null;
  finalScore: number | null;
  /** Drives the Retry affordance and its cap. See lib/assessment/grading-recovery. */
  gradingAttempts: number;
  lastGradingAttemptAt: number;
  updatedAt: number;
}

/** Header above the tutor submission table. */
export interface SubmissionListHeader {
  assignmentId: string;
  title: string;
  className: string;
  subjectName: string;
  dueDate: number;
  maxMarks: number;
  markingGuide: string;
  submittedCount: number;
  /** Active students in the class, from ResultPeak. */
  classSize: number;
}

export type SubmissionFilter = "all" | "pending_review" | "finalised";

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

/**
 * Device storage shapes live in `lib/offline/db.ts` beside the object stores
 * they are written to: `StoredAssignment`, `StoredSubmission`, `StoredDraft`,
 * `QueuedSubmission`. They are storage records, not domain types, and keeping
 * them next to the schema version that creates their stores is what stops the
 * two drifting.
 */
