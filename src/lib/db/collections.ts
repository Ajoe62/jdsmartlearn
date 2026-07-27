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
} as const;

export const RESULTPEAK_OWNED = new Set<string>([
  "schools", "classes", "students", "studentAccess", "exams", "examTemplates",
  "results", "examSessions", "theorySubmissions", "manualScores", "termNotes",
  "flags", "notifications", "adminAuditLogs", "studyDocuments", "admins",
]);

/** Hard cap on any query. Shared Spark quota - see CLAUDE.md. */
export const QUERY_LIMIT = 200;
