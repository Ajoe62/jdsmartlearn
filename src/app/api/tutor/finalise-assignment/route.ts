import { NextResponse } from "next/server";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getAssignment } from "@/lib/db/assignments";
import {
  averagePercentage,
  getSubmission,
  listFinalisedForSubject,
  updateSubmission,
} from "@/lib/db/submissions";
import { getProgress, progressId, upsertProgress } from "@/lib/db/progress";
import { syncContinuousAssessment } from "@/lib/db/academic-records";
import type { CaSyncOutcome } from "@/lib/db/academic-records";
import { writeAuditLog } from "@/lib/db/lessons";
import type { AssignmentSubmission } from "@/types/student-dashboard";

/**
 * Save a mark, or release it to the student.
 *
 *   action=draft     store the tutor's mark, keep it hidden
 *   action=finalise  release it, and sync the subject's CA score to ResultPeak
 *
 * Finalising is the ONLY way a score becomes student-visible. Nothing about a
 * high AI confidence shortcuts it (CLAUDE.md, Assessment rules).
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface Body {
  submissionId?: string;
  action?: "draft" | "finalise";
  teacherScore?: number | null;
  teacherComment?: string | null;
  /** The submission's updatedAt when the tutor started marking. */
  baseUpdatedAt?: number;
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const body = (await req.json().catch(() => ({}))) as Body;
  const id = body.submissionId?.trim() ?? "";
  const action = body.action ?? "finalise";
  if (!id) return bad("We couldn't tell which submission this is.");

  const submission = await getSubmission(id);
  if (!submission || submission.schoolId !== session.schoolId) {
    return bad("That submission no longer exists.", 404);
  }

  // ----- 1. Ownership. The assignment must be theirs, and the class must still
  // be assigned to them in ResultPeak, read fresh on this request. -----
  const assignment = await getAssignment(submission.assignmentId);
  if (!assignment || assignment.schoolId !== session.schoolId) {
    return bad("That assignment no longer exists.", 404);
  }
  if (!session.isAdmin && assignment.tutorId !== session.uid) {
    return bad("You didn't set this assignment.", 403);
  }
  try {
    assertClassAccess(session, assignment.classId);
  } catch {
    return bad("You don't teach that class.", 403);
  }

  /**
   * A mark queued offline days ago must not clobber one saved since. Same 409
   * contract as the lesson patch and publish routes.
   */
  if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt !== submission.updatedAt) {
    return NextResponse.json(
      {
        error:
          "This submission changed after you marked it. Open it again to see the newer version.",
      },
      { status: 409 }
    );
  }

  const teacherScore =
    body.teacherScore === null || body.teacherScore === undefined
      ? null
      : Math.max(0, Math.min(assignment.maxMarks, Math.round(Number(body.teacherScore))));

  if (body.teacherScore !== null && body.teacherScore !== undefined && teacherScore === null) {
    return bad(`Enter a mark between 0 and ${assignment.maxMarks}.`);
  }

  const teacherComment = body.teacherComment?.trim() || null;

  // ----- Draft: store the mark, release nothing. -----
  if (action === "draft") {
    await updateSubmission(id, {
      status: "teacher_reviewed",
      teacherScore,
      teacherComment,
    });
    return NextResponse.json({ ok: true, released: false });
  }

  // ----- 2. Finalise. -----
  const finalScore = teacherScore ?? submission.aiScore;
  if (finalScore === null) {
    return bad("Enter a mark before you release this. There is no AI mark to fall back on.");
  }

  const finalisedAt = Date.now();
  await updateSubmission(id, {
    status: "finalised",
    teacherScore,
    teacherComment,
    finalScore,
    finalisedAt,
  });

  // ----- 3. The running CA average for this subject this term. -----
  // Recomputed from the finalised submissions rather than incremented, so a
  // re-finalise or a corrected mark converges instead of drifting.
  let average: number | null = null;
  let finalisedCount = 0;
  try {
    // Term AND session, both read off the submission, never resolved now.
    const finalised = await listFinalisedForSubject(
      submission.schoolId,
      submission.studentId,
      submission.subjectId,
      submission.term,
      submission.session
    );
    const withThisOne = replaceOrAppend(finalised, {
      ...submission,
      finalScore,
      status: "finalised",
    });
    finalisedCount = withThisOne.length;
    average = averagePercentage(withThisOne);
  } catch (e) {
    console.error(`[finalise] ${id} step=average:`, e);
  }

  /**
   * ----- 4. Sync to ResultPeak. Guarded, merged, two fields only. -----
   *
   * NO DEFAULT AND NO FALLBACK on the assessment type. If the school has not
   * mapped one, or the one it mapped has since been removed from its
   * `assessmentTypes`, the sync is SKIPPED and logged. It is never redirected to
   * another type.
   *
   * That is not caution for its own sake. Some schools have no coursework column
   * at all: CAPSTONE ACADEMY runs only first_assessment, second_assessment and
   * exam. Writing into one of those would file a child's homework under a test
   * they never sat. ResultPeak's own `matchAssessmentType()` refuses the same
   * substitution, with the same reasoning in its comment.
   */
  let caOutcome: CaSyncOutcome = {
    status: "skipped",
    reason: "nothing_released",
    detail: "no finalised marks yet",
  };

  if (average !== null) {
    caOutcome = await syncContinuousAssessment({
      schoolId: submission.schoolId,
      studentId: submission.studentId,
      subjectId: submission.subjectId,
      session: submission.session,
      term: submission.term,
      percentage: average,
      submissionCount: finalisedCount,
    });
  }

  if (caOutcome.status === "skipped") {
    // Never silent. The tutor page reads these audit entries to explain itself.
    await writeAuditLog({
      schoolId: submission.schoolId,
      actorUid: session.uid,
      action: "assignment.ca.skipped",
      entityId: id,
      detail: `reason=${caOutcome.reason} ${caOutcome.detail}`,
    }).catch((e) => console.error(`[finalise] ${id} step=ca-skip-audit:`, e));
  }

  // ----- 5. Progress. -----
  try {
    const existing = await getProgress(
      progressId(submission.schoolId, submission.studentId, submission.subjectId)
    );
    await upsertProgress(
      submission.schoolId,
      submission.studentId,
      submission.subjectId,
      {
        subjectName: submission.subjectName,
        assignmentsGraded: (existing?.assignmentsGraded ?? 0) + 1,
        averageScore: average,
      }
    );
  } catch (e) {
    console.error(`[finalise] ${id} step=progress:`, e);
  }

  // ----- 6. Audit. -----
  try {
    await writeAuditLog({
      schoolId: submission.schoolId,
      actorUid: session.uid,
      action: "assignment.finalise",
      entityId: id,
      detail: [
        `final=${finalScore}/${assignment.maxMarks}`,
        `ai=${submission.aiScore ?? "none"}`,
        // Whether the tutor overrode the AI is the quality metric for marking,
        // exactly as tutorEdited is for generated lessons.
        `overrode=${teacherScore !== null && teacherScore !== submission.aiScore}`,
        average === null ? "ca=none" : `ca=${average}`,
      ].join(" "),
    });
  } catch (e) {
    console.error(`[finalise] ${id} step=audit:`, e);
  }

  return NextResponse.json({ ok: true, released: true, finalScore, continuousAssessment: average });
}

/** The just-finalised submission may or may not be in the query's results yet. */
function replaceOrAppend(
  rows: AssignmentSubmission[],
  updated: AssignmentSubmission
): AssignmentSubmission[] {
  const without = rows.filter((r) => r.id !== updated.id);
  return [...without, updated];
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
