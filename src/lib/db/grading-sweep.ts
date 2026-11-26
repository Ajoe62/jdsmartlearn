import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, LIST_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import { writeAuditLog } from "./lessons";
import {
  GRADING_ATTEMPT_CAP,
  SWEEPABLE_STATUSES,
  selectExhausted,
  selectStuck,
  staleThresholdMs,
} from "@/lib/assessment/grading-recovery";
import type { SweepCandidate } from "@/lib/assessment/grading-recovery";
import { aiMayWrite, mayClaimAttempt } from "@/lib/assessment/marking";
import { updateSubmissionWhen } from "./submissions";
import type { AssignmentSubmission } from "@/types/student-dashboard";

/**
 * Retry grading for submissions whose trigger never landed.
 *
 * PULL ON DEMAND, not cron. Vercel Hobby caps cron at once a day, which is
 * useless inside a school day. This runs when a tutor opens the page that would
 * show the result, which is exactly when someone cares, and from an explicit
 * Retry action on one row.
 *
 * THE QUERY IS EQUALITY ONLY, ON PURPose. See the note below.
 */

/**
 * Whether AI marking is switched on for this deployment at all.
 *
 * ONE definition, read by the submit route (which decides the committed status),
 * by the sweep and the retry action (which must not pretend to re-send), and by
 * the tutor page's skip surface (which has to say so in plain words). A second
 * `Boolean(process.env.INTERNAL_TASK_SECRET)` somewhere else is how a tutor ends
 * up being told marking is running while nothing is marking.
 *
 * Server-side only, deliberately. In a browser bundle the variable is undefined
 * and this would always read false, which would tell every tutor that marking is
 * off. That is why it lives in this `server-only` module.
 */
export function gradingEnabled(): boolean {
  return gradingSecret() !== null;
}

/** The shared secret, or null. Module-local: nothing outside needs the value. */
function gradingSecret(): string | null {
  return process.env.INTERNAL_TASK_SECRET || null;
}

/**
 * Candidates for one assignment.
 *
 * Three equality filters and an explicit limit. NO range filter and no orderBy,
 * so this needs NO composite index, which keeps the property every other query
 * in this repo has (docs/firestore-indexes-to-append.md).
 *
 * The staleness comparison is a RANGE by nature: "last attempted more than ten
 * minutes ago". Doing it in Firestore would combine an equality filter with a
 * range on a different field and force a composite index. Doing it in memory
 * over an assignment-scoped, limited result set costs nothing: one assignment is
 * one class, roughly forty documents, and the limit bounds it regardless.
 *
 * `submissions` is a FLAT top-level collection, so this is an ordinary
 * collection query. There is no collectionGroup query anywhere in this codebase.
 */
async function candidates(
  schoolId: string,
  assignmentId: string
): Promise<AssignmentSubmission[]> {
  const snap = await adminDb
    .collection(JD.submissions)
    .where("schoolId", "==", schoolId)
    .where("assignmentId", "==", assignmentId)
    .where("status", "in", SWEEPABLE_STATUSES as readonly string[])
    .limit(LIST_LIMIT)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AssignmentSubmission);
}

function toCandidate(s: AssignmentSubmission): SweepCandidate {
  return {
    id: s.id,
    status: s.status,
    submittedAt: s.submittedAt,
    // Documents written before these fields existed read as 0, which makes them
    // look stuck and eligible, which is the safe direction.
    gradingAttempts: s.gradingAttempts ?? 0,
    lastGradingAttemptAt: s.lastGradingAttemptAt ?? s.submittedAt,
  };
}

/**
 * Claim one more marking attempt, atomically. Returns the claimed submission,
 * or null when it is no longer waiting or another caller claimed it first.
 */
async function claimAttempt(
  id: string,
  expectedAttempts: number,
  attempt: number
): Promise<AssignmentSubmission | null> {
  assertWritable(JD.submissions);
  const ref = adminDb.doc(`${JD.submissions}/${id}`);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = { id: snap.id, ...snap.data() } as AssignmentSubmission;
    if (!mayClaimAttempt(current, expectedAttempts)) return null;
    const now = Date.now();
    const patch = { status: "ai_grading" as const, gradingAttempts: attempt, lastGradingAttemptAt: now, updatedAt: now };
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
}

export interface SweepResult {
  /** How many were re-sent for marking. */
  retried: number;
  /** How many were moved to ai_grading_failed because they ran out of attempts. */
  exhausted: number;
  /** True when grading is switched off entirely, so nothing was retried. */
  gradingDisabled: boolean;
}

/**
 * Sweep one assignment.
 *
 * Safe to call on every page load: it no-ops when nothing is stale, and the
 * stale threshold is minutes while grading takes seconds, so a submission still
 * in flight is never disturbed.
 */
export async function sweepAssignment(
  schoolId: string,
  assignmentId: string,
  origin: string,
  actorUid: string
): Promise<SweepResult> {
  const secret = gradingSecret();
  if (!secret) return { retried: 0, exhausted: 0, gradingDisabled: true };

  const rows = (await candidates(schoolId, assignmentId)).map(toCandidate);
  const opts = {
    now: Date.now(),
    thresholdMs: staleThresholdMs(),
    cap: GRADING_ATTEMPT_CAP,
  };

  /**
   * Out of attempts and still unmarked. Move them to a terminal status so the
   * tutor sees work that is theirs, rather than a row that quietly stopped being
   * retried while still claiming to be in progress.
   */
  /**
   * EVERY WRITE BELOW IS CONDITIONAL, re-checked inside its own transaction.
   *
   * `rows` was read once, at the start. The loop then waits 20 to 40 seconds
   * per row for the model, so by row five the list is minutes old, and the
   * tutor is looking at the same rows on the page that started this sweep, with
   * a live Release button. A blind write here used to flip a mark the tutor had
   * just released back to "ai_grading". See lib/assessment/marking.ts.
   */
  const exhausted = selectExhausted(rows, opts);
  for (const row of exhausted) {
    await updateSubmissionWhen(row.id, (s) => aiMayWrite(s.status), {
      status: "ai_grading_failed",
    }).catch(() => false);
  }

  const stuck = selectStuck(rows, opts);
  let retried = 0;

  for (const row of stuck) {
    const attempt = row.gradingAttempts + 1;
    let data: AssignmentSubmission | null = null;
    try {
      // Claim the attempt BEFORE triggering. If this instance dies immediately
      // after, the count has still moved, so the cap cannot be bypassed by
      // repeatedly killing the sweep. Claimed only if the row is still waiting
      // AND still on the attempt we read, so two sweeps (two tutors opening the
      // page together) cannot both claim it and spend the quota twice.
      data = await claimAttempt(row.id, row.gradingAttempts, attempt);
    } catch {
      continue;
    }
    if (!data) continue;

    try {
      // The same internal route the submit path calls. One grading path.
      await fetch(new URL("/api/ai/grade-assignment", origin), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-task": secret },
        body: JSON.stringify({
          assignmentId,
          studentId: data.studentId,
          schoolId,
          submissionId: row.id,
        }),
      });
      retried++;
    } catch {
      // The attempt is already recorded. The next sweep tries again, until the cap.
    }
  }

  if (retried > 0 || exhausted.length > 0) {
    await writeAuditLog({
      schoolId,
      actorUid,
      action: "assignment.grading.sweep",
      entityId: assignmentId,
      detail: `retried=${retried} exhausted=${exhausted.length} cap=${GRADING_ATTEMPT_CAP}`,
    }).catch(() => undefined);
  }

  return { retried, exhausted: exhausted.length, gradingDisabled: false };
}

/**
 * Retry ONE submission, from the tutor's explicit action.
 *
 * Ignores the stale threshold, because a tutor pressing Retry has decided it is
 * stuck. Still respects the attempt cap: a deterministic failure must not become
 * a button a tired teacher taps twenty times into the school's quota.
 */
export async function retryOne(
  schoolId: string,
  submissionId: string,
  origin: string,
  actorUid: string
): Promise<{ ok: boolean; reason?: "disabled" | "capped" | "not_stuck" }> {
  const secret = gradingSecret();
  if (!secret) return { ok: false, reason: "disabled" };

  const snap = await adminDb.doc(`${JD.submissions}/${submissionId}`).get();
  const sub = snap.exists ? ({ id: snap.id, ...snap.data() } as AssignmentSubmission) : null;
  if (!sub || sub.schoolId !== schoolId) return { ok: false, reason: "not_stuck" };

  const attempts = sub.gradingAttempts ?? 0;
  if (attempts >= GRADING_ATTEMPT_CAP) return { ok: false, reason: "capped" };
  if (!(SWEEPABLE_STATUSES as readonly string[]).includes(sub.status)) {
    return { ok: false, reason: "not_stuck" };
  }

  // Conditional, like the sweep: the tutor may have released it, or a sweep
  // claimed this attempt, since the read above.
  const claimed = await claimAttempt(submissionId, attempts, attempts + 1);
  if (!claimed) return { ok: false, reason: "not_stuck" };

  try {
    await fetch(new URL("/api/ai/grade-assignment", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-task": secret },
      body: JSON.stringify({
        assignmentId: sub.assignmentId,
        studentId: sub.studentId,
        schoolId,
        submissionId,
      }),
    });
  } catch {
    // Attempt recorded. The sweep will pick it up again after the threshold.
  }

  await writeAuditLog({
    schoolId,
    actorUid,
    action: "assignment.grading.retry",
    entityId: submissionId,
    detail: `attempt=${attempts + 1}/${GRADING_ATTEMPT_CAP}`,
  }).catch(() => undefined);

  return { ok: true };
}
