import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getStudentSession } from "@/lib/auth/student";
import { getAssignment, isSubmittable } from "@/lib/db/assignments";
import {
  createSubmission,
  denormalizedFrom,
  getSubmission,
  submissionId,
  toStudentSubmissionPayload,
} from "@/lib/db/submissions";
import { putFile, storageConfigured, STORABLE_TYPES } from "@/lib/storage/provider";
import {
  MAX_SUBMISSION_FILES,
  extensionOf,
  rejectAttachment,
} from "@/lib/storage/file-types";
import { writeAuditLog } from "@/lib/db/lessons";
import { gradingEnabled } from "@/lib/db/grading-sweep";
import type { SubmissionAttachment } from "@/types/student-dashboard";

export const maxDuration = 60;

/**
 * Student submissions. POST only, with an `action` field.
 *
 *   action=submit   hand in work, then start grading without awaiting it
 *   action=status   the current state of this student's submission
 *
 * A Next.js route handler in THIS app, not ResultPeak's api/ directory.
 * JDSmartLearn has its own Vercel function budget and is not subject to
 * ResultPeak's Hobby-plan 12-function cap.
 *
 * Every check here is server-side. The page hiding the form for a closed
 * assignment is a courtesy; this is the control.
 */

const MAX_CONTENT = 20_000;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const session = await getStudentSession();
  if (!session) return bad("Sign in to continue.", 401);

  // Submitting carries files, so it arrives as multipart. Status is JSON.
  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  let action = "";
  let assignmentId = "";
  let content = "";
  let files: File[] = [];
  let batchId: string | null = null;

  if (isMultipart) {
    const form = await req.formData();
    action = String(form.get("action") ?? "");
    assignmentId = String(form.get("assignmentId") ?? "");
    content = String(form.get("content") ?? "").trim();
    batchId = form.get("batchId") ? String(form.get("batchId")) : null;
    files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  } else {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      assignmentId?: string;
      content?: string;
      batchId?: string;
    };
    action = body.action ?? "";
    assignmentId = body.assignmentId ?? "";
    content = (body.content ?? "").trim();
    batchId = body.batchId ?? null;
  }

  if (!assignmentId) return bad("We couldn't tell which assignment this is.");

  const assignment = await getAssignment(assignmentId);
  if (!assignment || assignment.schoolId !== session.schoolId) {
    return bad("That assignment no longer exists.", 404);
  }
  // The class check is the student authorization model. Rules cannot do it:
  // students carry a signed cookie, not a Firebase Auth token.
  if (assignment.classId !== session.classId) {
    return bad("That assignment is not for your class.", 404);
  }

  const existing = await getSubmission(submissionId(assignmentId, session.studentId));

  if (action === "status") {
    if (!existing) return NextResponse.json({ submission: null });
    return NextResponse.json({ submission: toStudentSubmissionPayload(existing) });
  }

  if (action !== "submit") return bad("Unknown action.");

  /**
   * Idempotent, not just guarded. A double-tapped button, or a Background Sync
   * replaying the same queued submission, must read as "already in" rather than
   * as an error a child will retry.
   */
  if (existing) {
    return NextResponse.json(
      { ok: true, alreadySubmitted: true, submission: toStudentSubmissionPayload(existing) },
      { status: 200 }
    );
  }

  if (!assignment.isActive) return bad("Your teacher has closed this assignment.", 409);
  if (!isSubmittable(assignment)) {
    return bad("The time for this assignment has passed. Speak to your teacher.", 409);
  }

  if (content.length > MAX_CONTENT) {
    return bad("That answer is too long. Shorten it and send again.");
  }
  if (!content && files.length === 0) {
    return bad("Write an answer or attach a file before sending.");
  }
  if (files.length > MAX_SUBMISSION_FILES) {
    return bad(`Attach at most ${MAX_SUBMISSION_FILES} files.`);
  }

  // ----- Attachments. Uploaded before the document is written, so a failed
  // upload cannot leave a submission pointing at a file that does not exist.
  const attachments: SubmissionAttachment[] = [];
  if (files.length > 0) {
    if (!storageConfigured()) {
      return bad("Attachments are not available. Type your answer instead.");
    }
    /**
     * THE CONTROL, not the `accept` attribute on the form.
     *
     * `rejectAttachment` is the same function the tutor's form and the student's
     * form are built from, so all three agree about what a null on the document
     * meant and about which extensions exist at all. A request that never went
     * near the file picker, or an offline submission replayed days later, is
     * checked here exactly as a fresh one is.
     */
    for (const file of files) {
      const refusal = rejectAttachment(file, assignment.allowedFileTypes);
      if (refusal) return bad(refusal);

      const ext = extensionOf(file.name);
      const known = STORABLE_TYPES[ext];
      // rejectAttachment already required a submittable extension, so this is
      // unreachable; it stays because `known.mime` below must not be undefined
      // if the two lists ever drift.
      if (!known) return bad(`${file.name} is not a file type your teacher accepts.`);
      const key = `submissions/${session.schoolId}/${assignmentId}/${session.studentId}/${attachments.length}${ext}`;
      try {
        await putFile(key, Buffer.from(await file.arrayBuffer()), known.mime);
      } catch {
        return bad("We couldn't upload that file. Check your connection and try again.", 502);
      }
      attachments.push({ name: file.name, key, type: known.mime, size: file.size });
    }
  }

  const now = Date.now();

  /**
   * Whether grading will be attempted at all, decided BEFORE the write so the
   * committed status tells the truth.
   *
   * `status: "ai_grading"` means a trigger was fired and has not reported back.
   * `status: "submitted"` means no trigger was ever fired. The sweep in
   * `lib/assessment/grading-recovery.ts` needs to tell those apart: the first is
   * a lost trigger to retry, the second is a school running without
   * INTERNAL_TASK_SECRET, which retrying would not fix.
   *
   * One definition, shared with the sweep and with the tutor page's skip
   * surface, so a tutor is never told marking is running while nothing is.
   */
  const gradingOn = gradingEnabled();

  try {
    await createSubmission({
      ...denormalizedFrom(assignment),
      studentId: session.studentId,
      submittedAt: now,
      content,
      attachments,
      status: gradingOn ? "ai_grading" : "submitted",
      gradingAttempts: gradingOn ? 1 : 0,
      lastGradingAttemptAt: now,
      aiScore: null,
      aiMaxScore: null,
      aiConfidence: null,
      aiFeedback: null,
      aiStrengths: null,
      aiImprovements: null,
      topicsMastered: null,
      topicsToRevise: null,
      teacherScore: null,
      teacherComment: null,
      finalScore: null,
      finalisedAt: null,
      updatedAt: now,
    });
  } catch {
    // create() fails when the document exists. Two devices, or a replayed sync.
    const raced = await getSubmission(submissionId(assignmentId, session.studentId));
    if (raced) {
      return NextResponse.json({
        ok: true,
        alreadySubmitted: true,
        submission: toStudentSubmissionPayload(raced),
      });
    }
    return bad("We couldn't send your work. Try again.", 500);
  }

  /**
   * The submission is COMMITTED above. Only the grading call goes into
   * waitUntil.
   *
   * `void fetch(...)` was the bug this replaces. Once a route handler returns its
   * Response, Vercel may freeze or tear down the instance, so an unawaited call
   * can be killed before the request leaves the process. Nothing errors: the
   * submission simply sits unmarked forever, which looks exactly like a student
   * who has not been marked yet. waitUntil tells the runtime to keep the instance
   * alive until the promise settles.
   *
   * A child on 3G still does not wait for it, which is why it is not awaited
   * directly.
   */
  if (gradingOn) {
    waitUntil(
      triggerGrading(req, {
        assignmentId,
        studentId: session.studentId,
        schoolId: session.schoolId,
        submissionId: submissionId(assignmentId, session.studentId),
      })
    );
  } else {
    // Never silent. Same typed-reason shape as assignment.ca.skipped, read back
    // by the tutor page's skip surface.
    waitUntil(
      writeAuditLog({
        schoolId: session.schoolId,
        actorUid: "system",
        action: "assignment.grading.skipped",
        entityId: submissionId(assignmentId, session.studentId),
        detail: "reason=grading_disabled INTERNAL_TASK_SECRET is not set",
      }).catch(() => undefined)
    );
  }

  const stored = await getSubmission(submissionId(assignmentId, session.studentId));
  return NextResponse.json({
    ok: true,
    batchId,
    submission: stored ? toStudentSubmissionPayload(stored) : null,
  });
}

/**
 * Kick the internal grading route.
 *
 * A fetch to our own origin rather than a direct function call, so grading gets
 * its own function invocation and its own timeout budget instead of sharing this
 * request's. The shared secret is what makes the route internal: it is never
 * callable by a browser.
 */
async function triggerGrading(
  req: Request,
  payload: {
    assignmentId: string;
    studentId: string;
    schoolId: string;
    submissionId: string;
  }
): Promise<void> {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret) return; // Caller already decided and logged. Belt and braces.
  try {
    await fetch(new URL("/api/ai/grade-assignment", req.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-task": secret },
      body: JSON.stringify(payload),
    });
  } catch {
    // The tutor can still mark by hand. Never surface this to the student.
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
