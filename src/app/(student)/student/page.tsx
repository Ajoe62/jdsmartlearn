import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getNoticesForClass } from "@/lib/db/announcements";
import { getReadState } from "@/lib/db/read-state";
import { getSubjectShelf } from "@/lib/db/subject-shelf";
import { toNoticeItem, visibleToStudent } from "@/lib/announcements/notices";
import Announcements from "@/components/student/Announcements";
import DashboardView from "@/components/student/DashboardView";
import SubjectShelfView from "@/components/student/SubjectShelfView";
import { resultPeakStudentResultsUrl, resultPeakUrl } from "@/lib/partner-links";

/**
 * Student portal - read only. Server-rendered on the first visit (a cheap phone
 * gets content before any JS runs); afterwards the service worker serves the
 * shell and each slot renders the same data from IndexedDB.
 *
 * READS. The shelf and the announcements come from bundles cached per class and
 * shared by every student in it. Only two reads here are per-student and cannot
 * be shared: this child's own submissions (inside the shelf) and their own
 * announcement read state. Both buy something a child would notice.
 *
 * NEVER returns marking guide content. The shelf counts lessons through the safe
 * projection, announcements go through toNoticeItem, and neither shape has a
 * field a guide could occupy.
 */
export default async function StudentHome() {
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const [shelf, noticeCandidates, readState] = await Promise.all([
    getSubjectShelf(session.schoolId, session.classId, session.studentId),
    getNoticesForClass(session.schoolId, session.classId),
    getReadState(session.schoolId, session.studentId),
  ]);

  const notices = visibleToStudent(noticeCandidates, session.classId, Date.now()).map(
    toNoticeItem
  );

  // Two errands, so two links: sitting an exam and reading a result sheet.
  //
  // Neither carries the school. Both are the portal chooser or the sign-in page,
  // NOT /s/{slug}: the deep link would need the school's slug, the session
  // carries only its id, and looking one up would put another Firestore read on
  // every dashboard load of every student to save one tap.
  // See src/lib/partner-links.ts.
  const examsUrl = resultPeakUrl("/start");
  const resultsUrl = resultPeakStudentResultsUrl();

  return (
    <>
      <DashboardView
        announcements={<Announcements initial={notices} initialReadState={readState} />}
        shelf={
          <SubjectShelfView
            initial={shelf.subjects}
            initialTotals={shelf.totals}
            initialTerms={shelf.terms}
            subjectsIncomplete={shelf.subjectsIncomplete}
            hasUndated={shelf.hasUndated}
          />
        }
      />
      {examsUrl && resultsUrl && (
        <p className="mx-auto max-w-app px-5 pb-10 text-sm text-muted">
          <a
            className="underline"
            href={examsUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Take an exam
          </a>{" "}
          or{" "}
          <a
            className="underline"
            href={resultsUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            see your results
          </a>{" "}
          in ResultPeak. Use the same username and access code.
        </p>
      )}
    </>
  );
}
