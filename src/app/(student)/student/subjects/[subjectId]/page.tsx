import { notFound, redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getClassSyncBundle } from "@/lib/db/student-content";
import { listPublishedSchemesForClass } from "@/lib/db/schemes";
import { buildAssignmentList } from "@/lib/db/submissions";
import { getSubjects } from "@/lib/db/resultpeak";
import SubjectDetailView from "@/components/student/SubjectDetailView";

/**
 * One subject's page.
 *
 * Every read here is a bundle the dashboard already warmed and the whole class
 * shares, plus this student's own assignment list. Opening a subject after the
 * dashboard therefore costs one query, not five.
 *
 * SCOPING IS BY CONSTRUCTION. Both bundles are keyed on (schoolId, classId) from
 * the session, so a hand-edited subjectId can only ever select nothing from this
 * child's own class - it cannot reach another class's content. An unknown
 * subject 404s rather than rendering an empty page, so a mistyped link says so.
 */
export default async function SubjectPage({
  params,
}: {
  params: Promise<{ subjectId: string }>;
}) {
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const { subjectId: raw } = await params;
  const subjectId = decodeURIComponent(raw);

  const [bundle, schemes, assignments, subjects] = await Promise.all([
    getClassSyncBundle(session.schoolId, session.classId),
    listPublishedSchemesForClass(session.schoolId, session.classId),
    buildAssignmentList(session.schoolId, session.classId, session.studentId),
    getSubjects(session.schoolId),
  ]);

  const lessons = bundle.filter((l) => l.subjectId === subjectId);
  const mySchemes = schemes.filter((s) => s.subjectId === subjectId);
  const myAssignments = assignments.filter((a) => a.subjectId === subjectId);

  /**
   * The name comes from the school document, which is the canonical list. Fall
   * back to a name denormalized onto content only if the subject has been
   * removed from the school since - a page titled by a slug is worse than one
   * titled by a stale name, and both beat a 404 for content that exists.
   */
  const subjectName =
    subjects.find((s) => s.id === subjectId)?.name ??
    lessons[0]?.subjectName ??
    mySchemes[0]?.subjectName ??
    myAssignments[0]?.subjectName;

  if (!subjectName) notFound();

  return (
    <SubjectDetailView
      subjectId={subjectId}
      subjectName={subjectName}
      initialLessons={lessons.map((l) => ({
        lessonId: l.lessonId,
        title: l.title,
        hasMaterial: l.hasMaterial,
        hasStudyGuide: l.hasStudyGuide,
        term: l.term,
        session: l.session,
      }))}
      initialSchemes={mySchemes.map((s) => ({
        schemeId: s.id,
        title: s.title,
        term: s.term,
        session: s.session,
      }))}
      marks={myAssignments.map((a) => ({
        assignmentId: a.assignmentId,
        title: a.title,
        percentage: a.percentage,
        finalScore: a.finalScore,
        maxMarks: a.maxMarks,
        // `finalScore` is already null at every status but `finalised`; this
        // reads the status rather than inferring release from a number.
        isFinalised: a.status === "finalised",
        dueDate: a.dueDate,
      }))}
    />
  );
}
