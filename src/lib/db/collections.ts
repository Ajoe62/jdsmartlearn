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
  /**
   * `schoolDomains/{hostname}` -> `{ schoolId, active, isPrimary }`, where the
   * document id IS the normalised hostname. READ ONLY here, always.
   *
   * ResultPeak owns the write path (`api/_lib/domainActions.js`), which
   * validates the hostname, refuses reserved labels and enforces
   * one-school-per-address in a transaction. Those checks are therefore
   * invariants of the DATA rather than properties of one screen, and this repo
   * gets them for free by never writing.
   *
   * Read by document get, so there is no query, no index and no rules change
   * needed on this side. A read is one document per non-platform hostname per
   * cache window; a platform host is never looked up at all
   * (`shouldLookUpHost`), which is what keeps the shared domain from spending
   * the Spark quota on documents that do not exist.
   *
   * NOTHING RESOLVED FROM HERE IS A PERMISSION. See lib/routing/hostname.ts.
   */
  schoolDomains: "schoolDomains",
  /**
   * `schoolBranding/{schoolId}`: how a school looks, before anybody signs in.
   * READ ONLY here, always.
   *
   * A DERIVED PROJECTION of `schools/{id}.branding`, written by exactly one
   * writer in ResultPeak immediately after a school admin saves. Data flows one
   * way and never back. A write from here would be a second writer on a document
   * whose entire design is that it has one, and it would be reverted silently at
   * an unpredictable time - which is worse than being refused.
   *
   * This repo reads the PROJECTION rather than the source document because it is
   * smaller, it is what ResultPeak's own signed-out client reads, and it carries
   * `logoUpdatedAt` - a key that moves only when the crest bytes move.
   *
   * ABSENT IS A REAL STATE. ResultPeak deletes this as a stage of its
   * school-purge cascade, so a missing projection means the school is gone, not
   * that it has yet to be backfilled. Never fall back to a cached crest.
   */
  schoolBranding: "schoolBranding",
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
   * Tutor notifications, the class activity feed AND school announcements, in
   * one collection split by `audience`. A separate feed collection would double
   * the writes for the same two equality queries. NOT ResultPeak's
   * `notifications`, which we never touch in either direction.
   *
   * The name predates announcements and is deliberately not being changed: it is
   * in ResultPeak's deployed `firestore.rules`, and renaming a collection in a
   * shared project to improve a word is not worth a rules deploy against a live
   * school. Interpret every document through `normaliseNotice()` in
   * `lib/announcements/notices.ts` - rows written before 2026-08-22 carry none
   * of the announcement fields, and that function is where the defaults live.
   */
  notifications: "jdNotifications",
  /**
   * What one reader has already seen: a `seenAt` high-water mark and a capped
   * list of individually dismissed notice ids, at `${schoolId}_${readerId}`.
   *
   * ONE DOCUMENT PER READER, never one per reader per notice. The obvious
   * `{noticeId}_{studentId}` shape grows as notices x students without bound.
   * Holds no personal data: a reader id, two timestamps, and notice ids.
   */
  readState: "jdReadState",
  /**
   * THERE IS DELIBERATELY NO `jdClassSubjects` COLLECTION, and adding one back
   * would be a step backwards.
   *
   * The subjects a class offers have to be derived here, because ResultPeak has
   * no per-class subject list - `schools/{id}.subjects[]` is school-wide and
   * `classes/{id}` carries no subjects at all. The obvious move is to persist
   * that derivation at `${schoolId}_${classId}` and rebuild it on lesson publish
   * and assignment create.
   *
   * It was designed that way and then dropped, because the expensive half is the
   * TUTOR ALLOCATION SCAN, and a per-class document does not make it cheaper: a
   * school with twelve classes would rebuild twelve documents from twelve scans
   * of the same `schools/{id}/tutors` collection, up to 200 reads each.
   * `getSchoolAllocation()` in `db/class-subjects.ts` caches that ONE scan per
   * school instead, and every class is then derived from it for free.
   *
   * What a document would have added on top of that: a write on every rebuild, a
   * second staleness window to reason about beside the cache's, and a collection
   * to delete when `classes/{id}.subjectIds[]` ships in ResultPeak. See
   * `docs/resultpeak-class-subjects-prompt.md`.
   */
  /**
   * Scheme of work / curriculum documents a tutor uploads for a (class, subject).
   *
   * Separate from `lessons` on purpose. A scheme has no AI generation, no
   * practice questions, no marking guide and its own publish switch; folding it
   * into `lessons` would put four unused fields on every lesson and a `kind`
   * check on every query that reads one. It reuses the R2 storage provider and
   * the authenticated file route, which is the part worth sharing.
   */
  schemes: "schemes",
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

/**
 * Collections ResultPeak owns. `assertWritable()` refuses every write to one.
 *
 * `attendance` is the newest entry and the one most worth understanding, because
 * it was missing from this set for a while after ResultPeak shipped it - which
 * meant the guard that exists to stop this repo touching a paying school's data
 * would have let an attendance write straight through.
 *
 * It is a flat collection, one document per class per day, at the natural key
 * `{schoolId}_{classId}_{YYYY-MM-DD}`, written only by the named class teacher
 * and enforced in ResultPeak's rules. THE DETERMINISTIC ID IS WHY THIS MATTERS
 * MORE THAN MOST: a write from here would not create a stray parallel record
 * that somebody could spot and delete later, it would land on top of the real
 * register for that class on that day. Two registers for one class on one day is
 * a data problem nobody can untangle afterwards, because neither side can tell
 * which entries were the teacher's.
 *
 * If JDSmartLearn ever needs attendance, READ this collection. Do not write it
 * and do not mirror it into a JD collection - a mirror is the same problem with
 * an extra step, since it drifts silently the moment a teacher edits the
 * original. The same reasoning applies to `termNotes`, which holds term comments
 * and skill ratings and is class-teacher-only once a school enables allocation.
 */
export const RESULTPEAK_OWNED = new Set<string>([
  "schools", "classes", "students", "studentAccess", "exams", "examTemplates",
  "results", "examSessions", "theorySubmissions", "manualScores", "termNotes",
  "flags", "notifications", "adminAuditLogs", "studyDocuments", "admins",
  "attendance",
  /**
   * The addresses a school answers on, and how it looks before anyone signs in.
   * Both are ResultPeak's, and both are newer than most of this list.
   *
   * `schoolDomains` is written by ResultPeak's admin screens, which validate the
   * hostname and hold one-school-per-address in a transaction. A write from here
   * would land at a DETERMINISTIC id - the hostname itself - so it would not
   * create a stray row somebody could spot, it would land on top of the real
   * mapping. That is the same argument as `attendance` above, and it is the
   * reason both are named here rather than left to good intentions.
   *
   * `schoolBranding` is a DERIVED PROJECTION of `schools/{id}.branding`, written
   * by exactly one writer in ResultPeak immediately after it saves the school
   * (`api/_lib/branding/publicBranding.js`, "data flows one way and NEVER
   * back"). A write from here would be a second writer on a document whose whole
   * design is that it has one, and it would be silently reverted the next time a
   * school admin saved their profile. READ it; never write it.
   *
   * THIS REPO OWNS NO PART OF BRANDING, including the crest bytes. It briefly
   * had a rival record in `jdSchoolSettings.branding`, a crest in R2 and an
   * editor of its own; all three were removed on 2026-08-29, not deprecated.
   * `/api/schools/[schoolId]/logo` decodes the data URI on this projection - it
   * reaches no object store, so a school purge has no branding files to sweep.
   * See lib/branding/school.ts.
   */
  "schoolDomains", "schoolBranding",
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

/**
 * Cap on one audience's notice query, per query.
 *
 * Tighter again, and it is the reason the date window can be applied in memory:
 * whatever a school has posted since September, at most this many documents are
 * ever examined, and the live subset is smaller still. It also bounds the unread
 * pile a student who has never opened the app can face - see the note on
 * `seenAt` in `lib/announcements/notices.ts`.
 */
export const NOTICE_LIMIT = 40;
