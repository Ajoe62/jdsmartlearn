import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { gradeSubmission } from "@/lib/ai/provider";
import type { ImagePart } from "@/lib/ai/provider";
import { MAX_SUBMISSION_CHARS } from "@/lib/ai/prompt";
import { getAssignment, writeNotification } from "@/lib/db/assignments";
import { getSubmission, updateSubmission } from "@/lib/db/submissions";
import { getProgress, mergeTopics, progressId, removeMastered, upsertProgress } from "@/lib/db/progress";
import { writeAuditLog } from "@/lib/db/lessons";
import { getFile } from "@/lib/storage/provider";
import { extractText } from "@/lib/extract/text";
import { adminDb } from "@/lib/firebase/admin";
import {
  GRADING_ATTEMPT_CAP,
  SWEEPABLE_STATUSES,
} from "@/lib/assessment/grading-recovery";
import { JD } from "@/lib/db/collections";

export const maxDuration = 60;

/**
 * Mark one submission.
 *
 * INTERNAL. Called by the submit handler, never by a browser. The shared secret
 * is what makes that true: without it this would be an unauthenticated endpoint
 * that spends the school's daily AI quota on request.
 *
 * The result is NOT student-visible. It lands as `ai_graded` and waits for a
 * tutor to release it (CLAUDE.md, Assessment rules).
 *
 * Every step is wrapped. A partial save beats total failure: if progress fails
 * to update, the mark itself is still on the submission and the tutor can work.
 */

/** Grading calls per school per day. Students trigger these, not tutors, so the
 *  per-tutor generation cap does not bound them. Protects the shared free tier. */
const DAILY_CAP = Number(process.env.MAX_GRADINGS_PER_SCHOOL_PER_DAY ?? 200);

const MAX_IMAGES = 3;

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Constant-time compare, so the secret cannot be recovered a byte at a time. */
function secretMatches(provided: string | null): boolean {
  const expected = process.env.INTERNAL_TASK_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!secretMatches(req.headers.get("x-internal-task"))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    assignmentId?: string;
    studentId?: string;
    schoolId?: string;
    submissionId?: string;
  };

  const { assignmentId, studentId, schoolId, submissionId: id } = body;
  if (!assignmentId || !studentId || !schoolId || !id) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const step = (name: string, e: unknown) =>
    console.error(`[grade] ${id} step=${name}:`, e instanceof Error ? e.message : e);

  // ----- 3 and 4. Load both documents. -----
  const [assignment, submission] = await Promise.all([
    getAssignment(assignmentId),
    getSubmission(id),
  ]);

  if (!assignment || assignment.schoolId !== schoolId) {
    step("fetch-assignment", "not found");
    return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
  }
  if (!submission || submission.schoolId !== schoolId || submission.studentId !== studentId) {
    step("fetch-submission", "not found");
    return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  }
  /**
   * Which statuses this route will act on.
   *
   * "ai_grading" is now the NORMAL entry state: the submit route commits it
   * before firing the trigger, so a lost trigger is distinguishable from one that
   * was never fired. "submitted" arrives from a sweep retrying a submission made
   * while grading was disabled.
   *
   * Anything further along is finished or belongs to the tutor. A replayed
   * trigger must not re-spend quota or overwrite a mark a tutor has since edited.
   */
  if (!(SWEEPABLE_STATUSES as readonly string[]).includes(submission.status)) {
    return NextResponse.json({ ok: true, skipped: submission.status });
  }

  /**
   * The attempt cap is enforced HERE as well as in the sweep, because this route
   * is reachable from both the submit path and the sweep. A cap checked in only
   * one caller is a cap that leaks.
   */
  if (submission.gradingAttempts > GRADING_ATTEMPT_CAP) {
    await updateSubmission(id, { status: "ai_grading_failed" }).catch((e) =>
      step("cap-status", e)
    );
    return NextResponse.json({ ok: true, skipped: "attempt-cap" });
  }

  // ----- Daily cap. Equality filters only, so no composite index. -----
  try {
    const today = await adminDb
      .collection(JD.auditLogs)
      .where("schoolId", "==", schoolId)
      .where("action", "==", "assignment.grade")
      .where("dateKey", "==", dayKey(Date.now()))
      .limit(DAILY_CAP)
      .get();
    if (today.size >= DAILY_CAP) {
      // Not an error for the student. The tutor marks it by hand.
      await updateSubmission(id, { status: "ai_grading_failed" }).catch((e) =>
        step("cap-status", e)
      );
      return NextResponse.json({ ok: true, skipped: "daily-cap" });
    }
  } catch (e) {
    step("daily-cap", e);
    // Fall through. A cap we could not read must not block a child's marking.
  }

  // Status is already "ai_grading": the caller committed it before triggering.
  // Setting it here would erase the distinction the sweep depends on.

  // ----- 5. Build the text the model marks. -----
  let submissionText = submission.content;
  const images: ImagePart[] = [];

  for (const attachment of submission.attachments) {
    try {
      const stored = await getFile(attachment.key);
      if (!stored) continue;

      if (attachment.type.startsWith("image/")) {
        // No extractor can read a photograph of an exercise book. It goes to the
        // vision path instead, which is how most handwritten work arrives here.
        if (images.length < MAX_IMAGES) {
          images.push({
            data: stored.body.toString("base64"),
            mimeType: attachment.type,
          });
        }
        continue;
      }

      const file = new File([new Uint8Array(stored.body)], attachment.name, {
        type: attachment.type,
      });
      submissionText += `\n\n${await extractText(file)}`;
    } catch (e) {
      // One unreadable attachment must not lose the typed answer beside it.
      step(`attachment:${attachment.name}`, e);
    }
  }

  submissionText = submissionText.trim().slice(0, MAX_SUBMISSION_CHARS);

  if (!submissionText && images.length === 0) {
    await updateSubmission(id, { status: "ai_grading_failed" }).catch((e) => step("empty", e));
    return NextResponse.json({ ok: true, skipped: "nothing-to-mark" });
  }

  // ----- 6, 7, 8, 9. Mark it. The provider picks the model from the hint and
  // retries once on a schema failure before giving up. -----
  let graded;
  try {
    graded = await gradeSubmission(
      {
        // Nothing identifying. Not the student, not the tutor, not the school.
        assignmentTitle: assignment.title,
        subjectName: assignment.subjectName,
        markingGuide: assignment.markingGuide,
        maxMarks: assignment.maxMarks,
        submissionText,
      },
      images
    );
  } catch (e) {
    step("generate", e);
    /**
     * Terminal ONLY at the cap. A 429 from Gemini, a cold start, or a network
     * blip is transient, and marking it failed on the first one would hand a
     * tutor work the machine could have done. Below the cap the status stays
     * "ai_grading" so the sweep picks it up again after the stale threshold.
     */
    const exhausted = submission.gradingAttempts >= GRADING_ATTEMPT_CAP;
    if (exhausted) {
      await updateSubmission(id, { status: "ai_grading_failed" }).catch((err) =>
        step("fail-status", err)
      );
    }
    if (!exhausted) {
      return NextResponse.json({ ok: false, retryable: true }, { status: 200 });
    }
    await writeNotification({
      schoolId,
      audience: "tutor",
      targetId: assignment.tutorId,
      type: "grading_failed",
      title: assignment.title,
      body: "One submission needs marking by hand.",
      entityId: assignmentId,
    }).catch((err) => step("fail-notify", err));
    return NextResponse.json({ ok: false, error: "grading failed" }, { status: 200 });
  }

  // ----- 10. Clamp. The schema already bounds this; so does the route. A model
  // returning 40 out of 25 would inflate a real child's continuous assessment. -----
  const score = Math.max(0, Math.min(assignment.maxMarks, Math.round(graded.result.score)));

  // ----- 11. Store the mark. From here on, every failure is survivable. -----
  try {
    await updateSubmission(id, {
      status: "ai_graded",
      aiScore: score,
      aiMaxScore: assignment.maxMarks,
      aiConfidence: graded.result.confidence,
      aiFeedback: graded.result.feedback,
      aiStrengths: graded.result.strengths,
      aiImprovements: graded.result.improvements,
      topicsMastered: graded.result.topicsMastered,
      topicsToRevise: graded.result.topicsToRevise,
    });
  } catch (e) {
    step("save-result", e);
    return NextResponse.json({ ok: false, error: "could not save" }, { status: 500 });
  }

  // ----- 12. Progress. Topics merge; the average waits for the tutor.
  // An unreleased mark must not move a number the student can see. -----
  try {
    const existing = await getProgress(progressId(schoolId, studentId, assignment.subjectId));
    const mastered = mergeTopics(existing?.topicsMastered ?? [], graded.result.topicsMastered);
    const toRevise = removeMastered(
      mergeTopics(existing?.topicsToRevise ?? [], graded.result.topicsToRevise),
      mastered
    );
    await upsertProgress(schoolId, studentId, assignment.subjectId, {
      subjectName: assignment.subjectName,
      topicsMastered: mastered,
      topicsToRevise: toRevise,
    });
  } catch (e) {
    step("progress", e);
  }

  // ----- 13. Metrics. Same fields as a generation log. -----
  try {
    await writeAuditLog({
      schoolId,
      // The student did not ask for this and the tutor did not either. The
      // system spent the quota, so the system owns the log line.
      actorUid: "system",
      action: "assignment.grade",
      entityId: id,
      detail: [
        `model=${graded.meta.model}`,
        `in=${graded.meta.inputTokens}`,
        `out=${graded.meta.outputTokens}`,
        `ms=${graded.meta.latencyMs}`,
        `usd=${graded.meta.wouldBeCostUsd.toFixed(6)}`,
        `score=${score}/${assignment.maxMarks}`,
        `confidence=${graded.result.confidence}`,
      ].join(" "),
    });
  } catch (e) {
    step("audit", e);
  }

  // ----- 14. Tell the tutor there is something to review. -----
  try {
    await writeNotification({
      schoolId,
      audience: "tutor",
      targetId: assignment.tutorId,
      type: "submission_graded",
      title: assignment.title,
      body: "A submission is marked and waiting for your review.",
      entityId: assignmentId,
    });
  } catch (e) {
    step("notify", e);
  }

  return NextResponse.json({ ok: true, score, confidence: graded.result.confidence });
}

/** POST only. Anything else is not a soft failure, it is the wrong door. */
export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
