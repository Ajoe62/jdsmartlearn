import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { waitUntil } from "@vercel/functions";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getAssignment } from "@/lib/db/assignments";
import { listSubmissionsForAssignment } from "@/lib/db/submissions";
import { getStudentsInClass } from "@/lib/db/resultpeak";
import { usernamesForStudents } from "@/lib/db/student-logins";
import { sweepAssignment } from "@/lib/db/grading-sweep";
import { getSchoolSkips } from "@/lib/db/skips";
import SkipNotices from "@/components/tutor/SkipNotices";
import SubmissionReview from "@/components/tutor/SubmissionReview";
import type { TutorSubmissionRow } from "@/types/student-dashboard";

/**
 * Marking. Tutor-only, and it renders the marking guide.
 *
 * NETWORK-ONLY, permanently. `/tutor` is on the service worker deny-list, which
 * covers this route and must keep covering it: a cached copy of this page would
 * put marking guides in the Cache API on a phone (CLAUDE.md, Offline rules).
 * Submissions are cached in the tutor's namespaced IndexedDB store instead,
 * which is wiped when a different tutor signs in.
 */
export default async function SubmissionsPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const assignment = await getAssignment(assignmentId);
  if (!assignment || assignment.schoolId !== session.schoolId) return <NotFound />;
  if (!session.isAdmin && assignment.tutorId !== session.uid) return <NotFound />;
  try {
    assertClassAccess(session, assignment.classId);
  } catch {
    return <NotFound />;
  }

  /**
   * Everything currently stopping this school's marks getting through, worked
   * out here rather than left for a tutor to discover from a blank column on a
   * result sheet weeks later.
   *
   * ALL of them, not the first one: a school can have marking switched off AND
   * no assessment type mapped, and a tutor who fixes only what they were shown
   * will think they are done. Same no-fallback rule as the sync itself - an
   * unset or missing mapping is reported, never substituted.
   *
   * Gathered by `getSchoolSkips`, shared with the assignments page, so the two
   * cannot report different problems for the same school.
   */
  const [submissions, students, skips] = await Promise.all([
    listSubmissionsForAssignment(session.schoolId, assignmentId),
    getStudentsInClass(session.schoolId, assignment.classId),
    getSchoolSkips(session.schoolId),
  ]);

  /**
   * Retry any marking whose trigger never landed. PULL ON DEMAND: this is the
   * page that would show the result, so it is exactly when someone cares.
   *
   * In waitUntil, so the tutor does not wait for a whole class to be re-sent.
   * Results appear on the next load, and each stuck row carries its own Retry
   * action for a tutor who wants it now.
   *
   * Cheap when nothing is stuck: one equality-filtered query and no writes.
   */
  {
    const host = (await headers()).get("host");
    const proto = process.env.NODE_ENV === "production" ? "https" : "http";
    if (host) {
      waitUntil(
        sweepAssignment(
          session.schoolId,
          assignmentId,
          `${proto}://${host}`,
          session.uid
        ).catch(() => undefined)
      );
    }
  }

  // Usernames, not names. The tutor has names in ResultPeak; repeating a minor's
  // name in a JDSmartLearn surface adds personal data for no gain. Same rule as
  // the sign-in cards.
  const usernames = await usernamesForStudents(
    session.schoolId,
    submissions.map((s) => s.studentId)
  );

  const rows: TutorSubmissionRow[] = submissions.map((s) => ({
    submissionId: s.id,
    studentId: s.studentId,
    username: usernames.get(s.studentId) ?? null,
    submittedAt: s.submittedAt,
    status: s.status,
    aiScore: s.aiScore,
    aiConfidence: s.aiConfidence,
    teacherScore: s.teacherScore,
    finalScore: s.finalScore,
    // Absent on submissions written before the recovery fields existed.
    gradingAttempts: s.gradingAttempts ?? 0,
    lastGradingAttemptAt: s.lastGradingAttemptAt ?? s.submittedAt,
    updatedAt: s.updatedAt,
  }));

  const details = Object.fromEntries(
    submissions.map((s) => [
      s.id,
      {
        content: s.content,
        attachments: s.attachments.map((a, index) => ({
          name: a.name,
          size: a.size,
          // Signed at request time by the authenticated route, never a bucket URL.
          href: `/api/student/assignments/${assignmentId}/attachments/${index}?student=${encodeURIComponent(s.studentId)}`,
        })),
        aiFeedback: s.aiFeedback,
        aiStrengths: s.aiStrengths,
        aiImprovements: s.aiImprovements,
        teacherComment: s.teacherComment,
      },
    ])
  );

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/tutor/assignments" className="text-sm text-slate">
        Back to your assignments
      </Link>

      <h1 className="mt-3 text-2xl font-semibold">{assignment.title}</h1>
      <p className="mt-1 text-sm text-slate">
        {assignment.className} &middot; {assignment.subjectName} &middot; Due{" "}
        {new Date(assignment.dueDate).toDateString()}
      </p>
      <p className="mt-1 text-sm text-slate">
        {submissions.length} of {students.length} students have sent work
      </p>

      <SkipNotices reasons={skips} />

      <SubmissionReview
        maxMarks={assignment.maxMarks}
        markingGuide={assignment.markingGuide}
        rows={rows}
        details={details}
      />
    </main>
  );
}

function NotFound() {
  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/tutor/assignments" className="text-sm text-slate">
        Back to your assignments
      </Link>
      <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
        We couldn&rsquo;t find that assignment.
      </p>
    </main>
  );
}
