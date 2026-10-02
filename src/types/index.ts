// Shared domain types.
// NOTE: types prefixed ResultPeak* describe collections this app READS ONLY.

/**
 * Youngest first. Name every new level in LEVEL_LABELS (lib/class-level), which
 * is the one list everything else reads - the build fails until you do.
 */
export type ClassLevel =
  | "PN" | "N1" | "N2" | "N3"
  | "P1" | "P2" | "P3" | "P4" | "P5" | "P6"
  | "JSS1" | "JSS2" | "JSS3"
  | "SS1" | "SS2" | "SS3";

export const PRIMARY_LEVELS: ClassLevel[] = ["P1", "P2", "P3", "P4", "P5", "P6"];

export type Term = 1 | 2 | 3;
/** Role strings as ResultPeak actually stamps them onto custom claims. */
export type Role = "schooladmin" | "tutor";

/**
 * Firebase Auth custom claims set by ResultPeak's Admin SDK.
 * Interpret `role`/`superadmin` via isAdmin() in lib/auth/roles - never compare
 * the strings inline.
 */
export interface Claims {
  role: Role;
  /** The account's primary school - for admins, the school they administer. */
  schoolId: string;
  /** Newer multi-school accounts also carry every school they belong to. */
  schoolIds?: string[];
  active: boolean;
  /**
   * Set while the account still holds a temporary password a superadmin chose
   * for it. ResultPeak folds this into isActiveClaim() in firestore.rules, so
   * such an account is denied there while its `active` claim still reads true.
   * Read it through claimRefusal() in lib/auth/roles, never inline.
   */
  mustChangePassword?: boolean;
  superadmin?: boolean;
}

// ---------- ResultPeak-owned (READ ONLY) ----------

export interface ResultPeakSchool {
  name: string;
  /**
   * ResultPeak's STORED slug - the one it prints and links with, reserved for
   * uniqueness in `schoolSlugs/{slug}`. Authoritative; never derive over it.
   *
   * Optional because a school created before ResultPeak stored one has none.
   * Read it through `canonicalSchoolSlug()` in lib/db/resultpeak, which falls
   * back to the name-derived form for exactly that case.
   */
  slug?: string;
  subjects: { id: string; name: string }[];
  gradingScale: { min: number; letter: string; remark: string }[];
  isActive: boolean;
  /**
   * Whether this school enforces (classId, subjectId) tutor allocation.
   *
   * ABSENT MEANS OFF, and that is the whole reason the field exists. Without it
   * there is no way to tell "this school predates subject allocation" from
   * "this tutor was invited on Friday and nobody has allocated them yet" - and
   * treating the second as unrestricted is how an unallocated tutor silently
   * holds a whole school.
   *
   * Read it through getSubjectAllocationEnforced() in lib/db/resultpeak, never
   * off a school document somebody already had: see the note there about why
   * this one field is cached and the rest of the document is not.
   */
  subjectAllocation?: boolean;
}

export interface ResultPeakClass {
  name: string;
  schoolId: string;
  isActive: boolean;
  /** May be absent on older records - see docs/ARCHITECTURE.md */
  level?: ClassLevel;
}

export interface ResultPeakStudent {
  fullName: string;
  admissionNumber?: string;
  classId: string;
  className: string;
  schoolId: string;
  isActive: boolean;
  /**
   * When the APPROVED passport photo last changed; absent means no photo.
   * ResultPeak moves it in the same batch as `studentPhotos/{id}`, and only when
   * the approved bytes move. Read through `photoVersion()`, never directly - it
   * is another product's field and its shape is not ours to rely on.
   */
  photoUpdatedAt?: unknown;
}

/**
 * `studentPhotos/{studentId}` - ResultPeak's approved photo. READ ONLY here.
 * Only the fields this repo checks; the rest is theirs.
 */
export interface ResultPeakStudentPhoto {
  schoolId?: string;
  studentId?: string;
  /** "data:image/jpeg;base64,..." */
  dataUri?: string;
}

/**
 * ResultPeak's tutor profile. READ ONLY from here.
 *
 * A tutor used to be scoped by class alone. ResultPeak now allocates them by
 * (class, subject) pair, and the four allocation fields below are all OPTIONAL
 * because most tutors have not been allocated yet.
 *
 * An absent or empty allocation is not an error and is not "no access": it is
 * the legacy state, and it means every school subject across `assignedClasses`
 * - exactly the behaviour that shipped before. See src/lib/auth/subject-access.
 */
export interface ResultPeakTutor {
  /** UNCHANGED: still the derived union of every class in `assignments`. */
  assignedClasses: string[];
  name?: string;

  /** The truth, admin-edited in ResultPeak. The three below are derived from it. */
  assignments?: { classId: string; subjectId: string }[];
  /** subjectId -> classIds. The map every (class, subject) check reads. */
  subjectClasses?: Record<string, string[]>;
  assignedSubjects?: string[];
  /**
   * The class-teacher hat, 0 or 1 entry. Informational here and used nowhere:
   * ResultPeak owns term comments, skill ratings and attendance.
   */
  classTeacherOf?: string[];
}

// ---------- JDSmartLearn-owned (read + write) ----------

/**
 * RETIRED. The shape of a `studentLogins` document, read by one fallback branch
 * of `resolveUsername()` and by nothing else. Delete both in v0.2.0 - see
 * `docs/studentlogins-retirement.md`.
 *
 * A memorable sign-in name this repo used to mint: `jss3-04` instead of a
 * 20-character document id. ResultPeak now issues the username with the access
 * code, so nothing writes this any more.
 */
export interface StudentLogin {
  /** Doc id is `${schoolId}_${username}`, so sign-in is one get and no query. */
  schoolId: string;
  studentId: string;
  username: string;
  createdAt: number;
}

export interface Topic {
  id: string;
  schoolId: string;
  /** Slugified subject id from schools/{id}.subjects[] - the ResultPeak join key. */
  subjectId: string;
  level: ClassLevel;
  term: Term;
  position: number;
  title: string;
  objectives: string[];
  isCustom: boolean;
  createdAt: number;
}

export type LessonStatus = "draft" | "generating" | "generated" | "published";

/**
 * How a study note is organised (owner's decision, 2026-10-02).
 *
 *   "weekly"  one week's notes for a subject, which may cover several topics.
 *             The AI sorts it into topic sections; the tutor reviews them.
 *   "topic"   one topic's notes - the shape every lesson had before this field.
 *
 * ABSENT MEANS "topic". Every lesson written before 2026-10-02 is a topic note,
 * and is read as one without a backfill.
 */
export type NoteKind = "weekly" | "topic";

/**
 * School weeks in one term. Weeks RESET EACH TERM (owner's decision,
 * 2026-10-02): Week 1 of second term is not Week 14 of the year. A week number
 * therefore means nothing without the lesson's own `term` and `session`.
 */
export const MAX_WEEK = 14;

/** A topic a note covers, as a label. `id` is null for a name with no topic document. */
export interface NoteTopic {
  id: string | null;
  title: string;
}

/**
 * One topic section of a weekly note.
 *
 * `body` is THE TUTOR'S OWN WORDS, never the model's (owner's decision,
 * 2026-10-02). The model only says which paragraphs belong to which topic;
 * lib/notes/arrange assembles the body from the lesson's own paragraphs, so a
 * model cannot paraphrase, shorten or invent a sentence here even if it tries.
 *
 * Student-safe by construction: a heading, a topic label and lesson text. There
 * is no field a marking guide could occupy. Build the student copy only through
 * toStudentSections() in lib/db/lessons.
 */
export interface NoteSection {
  heading: string;
  topicId: string | null;
  topicTitle: string;
  body: string;
}

export interface Lesson {
  id: string;
  schoolId: string;
  /**
   * The topic a TOPIC note belongs to. Null on a weekly note, whose topics are
   * its sections' - a week usually covers more than one, and the tutor is not
   * asked to pick (owner's decision, 2026-10-02).
   */
  topicId: string | null;
  /**
   * The topic's title, copied at creation so a class sync can label a note by
   * topic without a topics read. Absent on lessons created before 2026-10-02;
   * those fall back to the title resolved at publish.
   */
  topicTitle?: string;
  /** Absent means "topic". See NoteKind. */
  kind?: NoteKind;
  /**
   * The school week within the lesson's own term, 1..MAX_WEEK, or null when
   * not set. Required on a weekly note, optional on a topic note. Absent on
   * lessons created before 2026-10-02, which show under "Week not set".
   */
  week?: number | null;
  /**
   * The approved topic sections of a weekly note, written on publish and
   * removed on unpublish - the same lifecycle as studentPayload.
   *
   * ON THE LESSON, NOT IN studentPayload, and deliberately so: studentPayload
   * rides the class sync bundle, which holds every lesson in a class in one
   * cached entry. A week's notes run to tens of KB, and a term of them would
   * push that entry past what the cache will hold - at which point every sync
   * becomes a Firestore query. Sections travel per lesson instead, with the
   * material text (getStudentMaterial).
   */
  studentSections?: NoteSection[];
  classId: string;
  className: string;
  subjectId: string;
  tutorId: string;
  title: string;
  /** Extracted text - always present, the readable default on slow networks. */
  extractedText: string;
  /** Original uploaded file, stored in R2 (absent for pasted-text lessons). */
  fileKey?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  /**
   * ResultPeak's term and session strings, copied BYTE FOR BYTE at creation and
   * never resolved again. Same rule as Assignment - see lib/academic-calendar.
   *
   * `null` on lessons created before 2026-08-22, and on lessons created while a
   * school admin has not set the current term yet. NEVER GUESSED FROM
   * `createdAt`: a Nigerian school year spans two calendar years and ResultPeak's
   * own session default is wrong for two thirds of it (docs/resultpeak-defects.md,
   * defect 1), so a guess would file a lesson under a term it was not taught in
   * and nothing would error. The subject shelf shows these under "Earlier".
   *
   * NOT to be confused with `Topic.term`, which is JDSmartLearn's own 1 | 2 | 3
   * curriculum ordering and takes part in no ResultPeak join.
   */
  term: string | null;
  session: string | null;
  /** Study-guide lifecycle. `published` means the AI study guide is student-visible. */
  status: LessonStatus;
  /** When the study guide was published. */
  publishedAt?: number;
  /**
   * When the raw lesson material (extractedText) was published to students.
   * Independent of the study guide - each publishes separately.
   */
  materialPublishedAt?: number;
  /**
   * Student-safe copy of the published study guide. Written on publish, removed
   * on unpublish. Present only while status === "published".
   */
  studentPayload?: StudentPayload;
  createdAt: number;
  updatedAt: number;
}

export interface PracticeQuestion {
  number: number;
  question: string;
}

export interface MarkingGuideEntry {
  number: number;
  keyPoints: string[];
}

export interface GeneratedContent {
  id: string;
  schoolId: string;
  lessonId: string;
  summary: string;
  questions: PracticeQuestion[];
  /** TUTOR-ONLY. Never include in a student response. */
  markingGuide: MarkingGuideEntry[];
  /** Weekly notes only: the topic sections, as arranged and then as edited. */
  sections?: NoteSection[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  wouldBeCostUsd: number;
  tutorEdited: boolean;
  version: number;
  createdAt: number;
}

/**
 * Student-safe copy of the published study guide, denormalized onto the lesson
 * doc at publish time so a whole class syncs in ONE query instead of an N+1 over
 * generatedContent (see docs/OFFLINE-FIRST.md).
 *
 * Build it ONLY via toStudentPayload() in lib/db/lessons - that function names
 * its fields instead of spreading GeneratedContent, so a marking guide cannot be
 * copied in by accident. This shape has no field one could occupy.
 */
export interface StudentPayload {
  summary: string;
  questions: PracticeQuestion[];
  /** Resolved from topics/{topicId} at publish time so sync needs no topic read. */
  topicTitle: string;
  /**
   * Every topic this note covers, for the "By topic" shelf. One entry on a
   * topic note; one per distinct section topic on a weekly note. Absent on
   * guides published before 2026-10-02 - readers fall back to `topicTitle`.
   */
  topics?: NoteTopic[];
  /** How many topic sections the lesson carries. The bodies live on the lesson. */
  sectionCount?: number;
  /** Bumped on every publish/edit so a device knows its copy is stale. */
  revision: number;
}

/** One lesson as it travels to a student device. Never carries a marking guide. */
export interface SyncLesson {
  lessonId: string;
  title: string;
  topicTitle: string;
  kind: NoteKind;
  /** Week within the lesson's own term, or null. Never compare across terms. */
  week: number | null;
  /**
   * Topic labels for the "By topic" view. Empty only on a weekly note whose
   * topic sorting is not published yet; every topic note has at least one.
   */
  topics: NoteTopic[];
  /** True when topic sections can be fetched with the lesson body. */
  hasSections: boolean;
  subjectId: string;
  subjectName: string;
  hasMaterial: boolean;
  hasStudyGuide: boolean;
  updatedAt: number;
  /**
   * Term and session, verbatim, so the subject shelf can filter WITH NO NETWORK.
   * Both null on lessons that predate the field - the shelf groups those under
   * "Earlier" and never guesses. See the note on Lesson.term.
   */
  term: string | null;
  session: string | null;
  studyGuide: { summary: string; questions: PracticeQuestion[] } | null;
  file: { name: string; size: number; inline: boolean } | null;
}

/** The index projection of SyncLesson - everything except the study guide body. */
export type SyncIndexEntry = Omit<SyncLesson, "studyGuide"> & {
  hasStudyGuide: boolean;
};

/** Study-guide shape returned to students. Structurally cannot carry a marking guide. */
export interface StudentLessonView {
  lessonId: string;
  title: string;
  topicTitle: string;
  summary: string;
  questions: PracticeQuestion[];
}

/**
 * What a student sees for one lesson: the raw material and/or the study guide,
 * each present only when its own publish switch is on. Never carries a marking
 * guide (studyGuide is the safe projection).
 */
export interface StudentLessonDetail {
  lessonId: string;
  title: string;
  topicTitle: string;
  kind: NoteKind;
  week: number | null;
  topics: NoteTopic[];
  /** Approved topic sections of a weekly note, or null. Published with the study guide. */
  sections: NoteSection[] | null;
  /** Published lesson material (extractedText), or null when not published. */
  material: string | null;
  /** Original file download info - only when material is published AND a file exists. */
  file: { name: string; size: number; inline: boolean } | null;
  /** Published study guide, or null when not published. */
  studyGuide: { summary: string; questions: PracticeQuestion[] } | null;
}
