/**
 * Collection names, split by ownership.
 * JDSmartLearn shares a Firestore database with ResultPeak (same Firebase project).
 */

/** ResultPeak owns these. READ ONLY - never write. */
export const RP = {
  schools: "schools",
  classes: "classes",
  students: "students",
  studentAccess: "studentAccess",
  results: "results",
  exams: "exams",
  tutors: (schoolId: string) => `schools/${schoolId}/tutors`,
} as const;

/** JDSmartLearn owns these. Read + write. */
export const JD = {
  topics: "topics",
  lessons: "lessons",
  generatedContent: "generatedContent",
  lessonViews: "lessonViews",
  auditLogs: "jdAuditLogs",
  /**
   * Credential alias only: username -> studentId, so a child types `jss3-04`
   * instead of a 20-character document id. Holds no personal data and is not a
   * roster - ResultPeak still owns the student and the access code.
   */
  studentLogins: "studentLogins",

  /** Work a tutor sets for one class. Holds a marking guide - tutor-only. */
  assignments: "assignments",
  /**
   * One student's answer, at the deterministic id `${assignmentId}_${studentId}`.
   *
   * FLAT, not a subcollection of `assignments`. Two reasons, both load-bearing:
   * the student's list needs `schoolId` AND `studentId` filters, which as a
   * collectionGroup query would require a COLLECTION_GROUP composite index in
   * ResultPeak's project-level index file; and a deterministic id turns "has this
   * student already submitted?" into one get instead of a query.
   */
  submissions: "submissions",
  /** Flat, at `${schoolId}_${studentId}_${subjectId}`. No subcollections. */
  studentProgress: "studentProgress",
  /**
   * Tutor notifications and the class activity feed in one collection, split by
   * `audience`. A separate feed collection would double the writes for the same
   * two equality queries. NOT ResultPeak's `notifications`, which we never touch.
   */
  notifications: "jdNotifications",
  /**
   * Per-school assessment settings, one document at `{schoolId}`.
   *
   * A STOPGAP. It holds the current academic term and session, which are
   * ResultPeak concepts that ResultPeak does not record anywhere: terms are a
   * hardcoded array in their frontend, sessions are free text with a date
   * default, and nothing marks which is current. ResultPeak should own this
   * field eventually. Read it only through `getCurrentTermSession()` in
   * `db/school-settings.ts`, so moving the source is a one-file change.
   */
  schoolSettings: "jdSchoolSettings",
  /**
   * JDSmartLearn's own record of every CA score it has calculated.
   *
   * Written BEFORE the shared `studentAcademicRecords` document, so an unguarded
   * write from the other platform can be replayed from here rather than lost.
   */
  caScores: "jdCaScores",
} as const;

/**
 * Owned by NEITHER platform. Keyed `${schoolId}_${studentId}`.
 *
 * Deliberately absent from both `JD` and `RESULTPEAK_OWNED`: this app may write
 * it, but only two fields of it. Reach it through the helpers in
 * `db/academic-records.ts`, which call `assertRecordFields()` first. See
 * CLAUDE.md, Assessment rules.
 */
export const SHARED = {
  studentAcademicRecords: "studentAcademicRecords",
} as const;

export const RESULTPEAK_OWNED = new Set<string>([
  "schools", "classes", "students", "studentAccess", "exams", "examTemplates",
  "results", "examSessions", "theorySubmissions", "manualScores", "termNotes",
  "flags", "notifications", "adminAuditLogs", "studyDocuments", "admins",
]);

/**
 * The ONLY keys JDSmartLearn may put in a `studentAcademicRecords` write.
 *
 * This list is the ALLOWLIST, not half of a pair. `assertRecordFields()` refuses
 * every root that is not here, at every depth, and deliberately knows nothing
 * about which fields ResultPeak owns. Adding a name here widens what this repo
 * may write to a document a paying school's report cards are built from, so it
 * is not a routine edit.
 *
 * `continuousAssessment` is written as a NESTED MAP with `set(..., { merge: true })`,
 * not as a dotted path: `set()` reads a key literally, so a dotted key would
 * create a field whose name contains a dot. Only `update()` reads dots as paths.
 * See the numbered note on `writeContinuousAssessment` in `db/academic-records.ts`.
 * The guard accepts either form, because a later `update()` would be legitimate
 * and must be checked just as strictly.
 *
 * Runtime source of truth for `assertRecordFields()`. Lives here rather than in
 * `types/`, because the scripts import this module by relative path and cannot
 * resolve the `@/` alias.
 */
export const LMS_WRITABLE_RECORD_FIELDS = [
  "continuousAssessment",
  "lastUpdatedByLMS",
] as const;

/**
 * Identity fields a create must stamp. Same values on both sides of the contract,
 * so writing them is idempotent and cannot clobber ResultPeak's half.
 */
export const RECORD_IDENTITY_FIELDS = ["schoolId", "studentId"] as const;

export type LMSWritableRecordField = (typeof LMS_WRITABLE_RECORD_FIELDS)[number];

/** Hard cap on any query. Shared Spark quota - see CLAUDE.md. */
export const QUERY_LIMIT = 200;

/**
 * Cap on a student-facing list query. Tighter than QUERY_LIMIT: a class can
 * accumulate assignments all year, and a phone on 3G should not download them all.
 */
export const LIST_LIMIT = 50;
