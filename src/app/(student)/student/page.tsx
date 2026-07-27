import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getClassSyncIndex } from "@/lib/db/student-content";
import DashboardView from "@/components/student/DashboardView";

/**
 * Student portal - read only. Server-rendered on the first visit (a cheap phone
 * gets content before any JS runs); afterwards the service worker serves the
 * shell and DashboardView renders the same data from IndexedDB.
 *
 * Reads the same cached class bundle the sync routes use, so the dashboard costs
 * no Firestore reads of its own. NEVER returns marking guide content - the index
 * is built from the safe projection in toStudentPayload.
 */
export default async function StudentHome() {
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const index = await getClassSyncIndex(session.schoolId, session.classId);

  return (
    <DashboardView
      initial={index.map((l) => ({
        lessonId: l.lessonId,
        title: l.title,
        subjectId: l.subjectId,
        subjectName: l.subjectName,
        hasMaterial: l.hasMaterial,
        hasStudyGuide: l.hasStudyGuide,
      }))}
    />
  );
}
