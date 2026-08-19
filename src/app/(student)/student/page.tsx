import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getClassSyncIndex } from "@/lib/db/student-content";
import DashboardView from "@/components/student/DashboardView";
import { resultPeakUrl } from "@/lib/partner-links";

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

  // The portal chooser, NOT /s/{slug}. The deep link would need the school's
  // slug, the session carries only its id, and looking one up would put a
  // Firestore read on every dashboard load of every student to save one tap.
  // This page is documented above as costing no reads of its own; keep it that
  // way. See src/lib/partner-links.ts.
  const examsUrl = resultPeakUrl("/start");

  return (
    <>
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
      {examsUrl && (
        <p className="mx-auto max-w-readable px-5 pb-10 text-sm text-slate">
          <a
            className="underline"
            href={examsUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Exams and results
          </a>{" "}
          are in ResultPeak. Use the same username and access code.
        </p>
      )}
    </>
  );
}
