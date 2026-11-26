import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "@/lib/db/collections";
import { assertWritable } from "@/lib/db/write-guard";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getAssignment } from "@/lib/db/assignments";
import { getSubmission } from "@/lib/db/submissions";
import { getProgress, progressId, upsertProgress } from "@/lib/db/progress";
import { sendMarkToReportCard } from "@/lib/db/ca-sync";
import { writeAuditLog } from "@/lib/db/lessons";
import { decideMarkingWrite } from "@/lib/assessment/marking";
import type { MarkingDecision, MarkingRequest } from "@/lib/assessment/marking";
import type { AssignmentSubmission } from "@/types/student-dashboard";

/**
 * Save a mark, release it, or send a released mark to the report card again.
 *
 *   action=draft     store the tutor's mark, keep it hidden
 *   action=finalise  release it, and send the subject's CA score to ResultPeak
 *   action=resend    send an already released mark to the report card again
 *
 * Finalising is the ONLY way a score becomes student-visible. Nothing about a
 * high AI confidence shortcuts it (CLAUDE.md, Assessment rules).
 *
 * TWO GUARANTEES, both added 2026-11-26 (see lib/assessment/marking.ts):
 *
 *  1. The version check and the write are ONE transaction. A release is final:
 *     a draft cannot un-release it and a late AI result cannot overwrite it.
 *  2. Sending to the report card never throws away the outcome. Success, skip
 *     or failure is recorded on the submission, and a failure is offered back
 *     to the tutor as "Send to report card again" instead of disappearing.
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface Body {
  submissionId?: string;
  action?: "draft" | "finalise" | "resend";
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
  if (action !== "draft" && action !== "finalise" && action !== "resend") {
    return bad("Unknown action.");
  }

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

  // ----- Resend: no change to the mark, only the report-card send. -----
  if (action === "resend") {
    if (submission.status !== "finalised" || submission.finalScore === null) {
      return bad("Release this mark first. Only released marks go to report cards.", 409);
    }
    const { record, average } = await sendMarkToReportCard(submission, session.uid);
    return NextResponse.json({
      ok: true,
      released: true,
      finalScore: submission.finalScore,
      continuousAssessment: average,
      caSync: record,
    });
  }

  const teacherScore =
    body.teacherScore === null || body.teacherScore === undefined
      ? null
      : Math.max(0, Math.min(assignment.maxMarks, Math.round(Number(body.teacherScore))));

  if (
    body.teacherScore !== null &&
    body.teacherScore !== undefined &&
    !Number.isFinite(Number(body.teacherScore))
  ) {
    return bad(`Enter a mark between 0 and ${assignment.maxMarks}.`);
  }

  const request: MarkingRequest = {
    action,
    teacherScore,
    teacherComment: body.teacherComment?.trim() || null,
    baseUpdatedAt: typeof body.baseUpdatedAt === "number" ? body.baseUpdatedAt : undefined,
  };

  // ----- 2. Decide and write in ONE transaction, on the newest copy. -----
  assertWritable(JD.submissions);
  const ref = adminDb.doc(`${JD.submissions}/${id}`);
  let decision: MarkingDecision;
  let stored: AssignmentSubmission;
  try {
    ({ decision, stored } = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new GoneError();
      const current = { id: snap.id, ...snap.data() } as AssignmentSubmission;
      const now = Date.now();
      const d = decideMarkingWrite(current, request, now);
      if (d.kind === "write") {
        tx.update(ref, { ...d.patch, updatedAt: now });
        return { decision: d, stored: { ...current, ...d.patch, updatedAt: now } };
      }
      return { decision: d, stored: current };
    }));
  } catch (e) {
    if (e instanceof GoneError) return bad("That submission no longer exists.", 404);
    throw e;
  }

  if (decision.kind === "refuse") return bad(decision.error, decision.status);

  if (decision.kind === "already_released") {
    // A replay of a release that already landed. Nothing changes; report what
    // is stored, including whether it reached the report card.
    return NextResponse.json({
      ok: true,
      released: true,
      alreadyReleased: true,
      finalScore: decision.finalScore,
      caSync: stored.caSync ?? null,
    });
  }

  if (!decision.releases) {
    return NextResponse.json({ ok: true, released: false });
  }

  const finalScore = stored.finalScore as number;

  // ----- 3 and 4. The running CA average for this column, sent to ResultPeak.
  // Never throws: the outcome is recorded on the submission either way. -----
  const { record, average } = await sendMarkToReportCard(stored, session.uid);

  // ----- 5. Progress. Only on a fresh release, so a replay cannot double count.
  try {
    const existing = await getProgress(
      progressId(submission.schoolId, submission.studentId, submission.subjectId)
    );
    await upsertProgress(submission.schoolId, submission.studentId, submission.subjectId, {
      subjectName: submission.subjectName,
      assignmentsGraded: (existing?.assignmentsGraded ?? 0) + 1,
      averageScore: average,
    });
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
        `ai=${stored.aiScore ?? "none"}`,
        // Whether the tutor overrode the AI is the quality metric for marking,
        // exactly as tutorEdited is for generated lessons.
        `overrode=${teacherScore !== null && teacherScore !== stored.aiScore}`,
        average === null ? "ca=none" : `ca=${average}`,
        `report=${record.status}`,
      ].join(" "),
    });
  } catch (e) {
    console.error(`[finalise] ${id} step=audit:`, e);
  }

  return NextResponse.json({
    ok: true,
    released: true,
    finalScore,
    continuousAssessment: average,
    caSync: record,
  });
}

class GoneError extends Error {}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
