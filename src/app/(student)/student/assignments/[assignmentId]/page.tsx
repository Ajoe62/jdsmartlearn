import Link from "next/link";
import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getAssignment, isSubmittable, toStudentAssignment } from "@/lib/db/assignments";
import { listVisibleLessonsForClass } from "@/lib/db/lessons";
import {
  getSubmission,
  linkTopics,
  submissionId,
  toStudentSubmissionPayload,
} from "@/lib/db/submissions";
import { storageConfigured } from "@/lib/storage/provider";
import GradedView from "@/components/student/GradedView";
import SubmissionForm from "@/components/student/SubmissionForm";
import SubmissionStatus from "@/components/student/SubmissionStatus";

/**
 * One assignment. Which of the three views renders is decided here, on the
 * server, from the stored submission:
 *
 *   finalised        GradedView
 *   any other status SubmissionStatus
 *   no submission    SubmissionForm
 *
 * The assignment is projected through toStudentAssignment() before it reaches
 * any of them, so the marking guide never crosses into a student component.
 */
export default async function StudentAssignmentPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const assignment = await getAssignment(assignmentId);
  if (
    !assignment ||
    assignment.schoolId !== session.schoolId ||
    assignment.classId !== session.classId ||
    !assignment.isActive
  ) {
    return <NotFound />;
  }

  const safe = toStudentAssignment(assignment);
  const submission = await getSubmission(submissionId(assignmentId, session.studentId));

  if (submission?.status === "finalised") {
    // Resolve "topics to revise" against lessons this class can actually open.
    // Nothing is fetched unless there are topics to match.
    const topics = submission.topicsToRevise ?? [];
    const lessons =
      topics.length > 0
        ? await listVisibleLessonsForClass(session.schoolId, session.classId)
        : [];
    const links = linkTopics(
      topics,
      lessons.map((l) => ({ id: l.id, title: l.title, subjectId: l.subjectId })),
      submission.subjectId
    );

    return (
      <GradedView
        assignment={safe}
        submission={toStudentSubmissionPayload(submission, links)}
      />
    );
  }

  if (submission) {
    return (
      <SubmissionStatus
        assignment={safe}
        submission={toStudentSubmissionPayload(submission)}
      />
    );
  }

  return (
    <SubmissionForm
      assignment={safe}
      open={isSubmittable(assignment)}
      filesAvailable={storageConfigured() && safe.allowedFileTypes.length > 0}
    />
  );
}

function NotFound() {
  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/student/assignments" className="text-sm text-muted">
        Back to your work
      </Link>
      <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
        We couldn&rsquo;t find that assignment. It may have been closed by your teacher.
      </p>
    </main>
  );
}
