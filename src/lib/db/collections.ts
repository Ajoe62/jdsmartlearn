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
} as const;

export const RESULTPEAK_OWNED = new Set<string>([
  "schools", "classes", "students", "studentAccess", "exams", "examTemplates",
  "results", "examSessions", "theorySubmissions", "manualScores", "termNotes",
  "flags", "notifications", "adminAuditLogs", "studyDocuments", "admins",
]);

/** Hard cap on any query. Shared Spark quota - see CLAUDE.md. */
export const QUERY_LIMIT = 200;
