import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getClassSyncIndex } from "@/lib/db/student-content";
import { listProgressForStudent } from "@/lib/db/progress";
import { getAcademicRecord } from "@/lib/db/academic-records";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { linkTopics } from "@/lib/db/submissions";
import { listVisibleLessonsForClass } from "@/lib/db/lessons";
import ProgressView from "@/components/student/ProgressView";
import type { SubjectProgressCard } from "@/types/student-dashboard";

/**
 * How this student is doing, one card per subject.
 *
 * Four reads, all bounded and all equality-filtered:
 *   progress documents  (limit 20, a student's maximum subject count)
 *   the shared academic record (one document, READ ONLY here)
 *   the cached class bundle, shared with every other student in the class
 *   lessons, only to resolve topic names to links
 *
 * The continuous assessment figure comes from studentAcademicRecords, which
 * JDSmartLearn writes but this page only reads.
 */
export default async function StudentProgressPage() {
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const [progress, record, index, lessons, settings] = await Promise.all([
    listProgressForStudent(session.schoolId, session.studentId),
    getAcademicRecord(session.schoolId, session.studentId),
    getClassSyncIndex(session.schoolId, session.classId),
    listVisibleLessonsForClass(session.schoolId, session.classId),
    /**
     * Only for `lmsAssessmentType`, which says WHICH column to read back. Not
     * for term or session: those are stamped on each submission and never
     * resolved at read time.
     */
    getCurrentTermSession(session.schoolId),
  ]);

  /**
   * CA is nested by assessment type on the shared document, so reading it back
   * needs the school's current mapping. When nothing is mapped there is nothing
   * reaching a report card, and the honest answer is null rather than a number
   * picked from whichever column happened to be first.
   */
  const mappedType = settings?.lmsAssessmentType ?? null;

  const lessonsBySubject = new Map<string, number>();
  for (const lesson of index) {
    lessonsBySubject.set(lesson.subjectId, (lessonsBySubject.get(lesson.subjectId) ?? 0) + 1);
  }

  const linkable = lessons.map((l) => ({
    id: l.id,
    title: l.title,
    subjectId: l.subjectId,
  }));

  const cards: SubjectProgressCard[] = progress.map((p) => ({
    subjectId: p.subjectId,
    subjectName: p.subjectName,
    lessonsViewed: p.lessonsViewed,
    lessonsAvailable: lessonsBySubject.get(p.subjectId) ?? 0,
    assignmentsSubmitted: p.assignmentsSubmitted,
    assignmentsGraded: p.assignmentsGraded,
    averageScore: p.averageScore,
    continuousAssessment:
      mappedType === null
        ? null
        : (record?.continuousAssessment[p.subjectId]?.[mappedType] ?? null),
    topicsMastered: p.topicsMastered,
    topicsToRevise: linkTopics(p.topicsToRevise, linkable, p.subjectId),
  }));

  return <ProgressView initial={cards} />;
}
