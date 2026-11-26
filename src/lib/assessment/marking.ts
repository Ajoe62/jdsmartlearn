/**
 * Who may change a submission, and when.
 *
 * PURE. No Firestore, no `server-only`, no `next/*`, for the same reason as
 * `ca.ts` and `grading-recovery.ts`: these rules decide whether a released mark
 * stays released, so they must be directly testable.
 *
 * THE BUG THIS EXISTS TO PREVENT (found 2026-11-26, before any school hit it).
 * Two writers touch one submission: the AI marking path (the submit trigger,
 * the stuck sweep and the Retry button) and the tutor. Every one of them used to
 * read the document, do slow work, then write blindly. The tutor's marking page
 * starts a sweep in the background while showing the same rows with a live
 * Release button, and a sweep waits 20 to 40 seconds per row for the model. A
 * tutor who released a mark inside that window had it overwritten: the status
 * went back to "ai_graded" or "ai_grading", the child's mark disappeared from
 * their screen, and because the CA average counts only finalised marks, the next
 * release in that subject quietly dropped it from the report card too.
 *
 * THE RULE, stated once: the tutor's decision is final. The AI side may write
 * only while the submission is still waiting for marking, checked inside the
 * same transaction as the write. The tutor's own writes check the version they
 * started from inside the same transaction too, so "read, then write" is never
 * two steps with a gap between them.
 */

import { SWEEPABLE_STATUSES } from "./grading-recovery";
import type { CaSkipReason } from "./ca";
import type { SubmissionStatus } from "@/types/student-dashboard";

/**
 * May the AI marking path write to a submission in this status?
 *
 * Only while it is waiting for marking. Everything past that belongs to the
 * tutor (`ai_graded` waits for them, `teacher_reviewed` and `finalised` are
 * theirs) or is terminal (`ai_grading_failed`). A late AI result for a
 * submission the tutor has already handled is discarded, never written.
 */
export function aiMayWrite(status: string | undefined): boolean {
  return (SWEEPABLE_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * May a sweep or a Retry claim one more marking attempt?
 *
 * The status must still be waiting AND the attempt count must be the one the
 * caller read. The second check is what stops two tutors opening the same page
 * at once from both claiming attempt 2 and spending the school's quota twice.
 */
export function mayClaimAttempt(
  current: { status?: string; gradingAttempts?: number },
  expectedAttempts: number
): boolean {
  return aiMayWrite(current.status) && (current.gradingAttempts ?? 0) === expectedAttempts;
}

/** What the tutor asked for. */
export interface MarkingRequest {
  action: "draft" | "finalise";
  /** Already clamped to 0..maxMarks by the route, or null for "use the AI mark". */
  teacherScore: number | null;
  teacherComment: string | null;
  /** The version the tutor started from. Absent only from very old clients. */
  baseUpdatedAt?: number;
}

/** The fields of the stored submission this decision reads. */
export interface MarkingCurrent {
  status: SubmissionStatus;
  aiScore: number | null;
  finalScore: number | null;
  updatedAt: number;
}

export type MarkingDecision =
  /** Write this patch. */
  | { kind: "write"; patch: MarkingPatch; releases: boolean }
  /**
   * Already released with this same mark. Answer success and change nothing.
   * This is how an offline-queued release whose first send succeeded but whose
   * reply was lost replays as "done" instead of as an error the tutor must clear.
   */
  | { kind: "already_released"; finalScore: number }
  | { kind: "refuse"; status: 400 | 409; error: string };

export interface MarkingPatch {
  status: "teacher_reviewed" | "finalised";
  teacherScore: number | null;
  teacherComment: string | null;
  finalScore?: number;
  finalisedAt?: number;
}

export const STALE_MARK_TEXT =
  "This submission changed after you marked it. Open it again to see the newer version.";
export const ALREADY_RELEASED_TEXT =
  "This mark is already released to your student, so it can't be changed here.";

/**
 * Decide what one tutor marking request does to the stored submission.
 *
 * Called INSIDE the transaction, on the copy the transaction just read, so the
 * version check and the write cannot be separated by another writer.
 */
export function decideMarkingWrite(
  current: MarkingCurrent,
  req: MarkingRequest,
  now: number
): MarkingDecision {
  // A release is final. Nothing un-releases it: not a draft, not a new number.
  if (current.status === "finalised") {
    if (
      req.action === "finalise" &&
      current.finalScore !== null &&
      (req.teacherScore === null || req.teacherScore === current.finalScore)
    ) {
      return { kind: "already_released", finalScore: current.finalScore };
    }
    return { kind: "refuse", status: 409, error: ALREADY_RELEASED_TEXT };
  }

  if (req.baseUpdatedAt !== undefined && req.baseUpdatedAt !== current.updatedAt) {
    return { kind: "refuse", status: 409, error: STALE_MARK_TEXT };
  }

  if (req.action === "draft") {
    return {
      kind: "write",
      releases: false,
      patch: {
        status: "teacher_reviewed",
        teacherScore: req.teacherScore,
        teacherComment: req.teacherComment,
      },
    };
  }

  // The AI mark is read from THIS copy, not from one read before the
  // transaction: it may have arrived in between.
  const finalScore = req.teacherScore ?? current.aiScore;
  if (finalScore === null) {
    return {
      kind: "refuse",
      status: 400,
      error: "Enter a mark before you release this. There is no AI mark to fall back on.",
    };
  }

  return {
    kind: "write",
    releases: true,
    patch: {
      status: "finalised",
      teacherScore: req.teacherScore,
      teacherComment: req.teacherComment,
      finalScore,
      finalisedAt: now,
    },
  };
}

// ---------------------------------------------------------------------------
// Whether a released mark reached the report card
// ---------------------------------------------------------------------------

/**
 * What happened when a released mark was sent to the report card, kept ON THE
 * SUBMISSION so the tutor's page can show it per child and offer to send again.
 *
 * Before this existed, a send that threw left nothing behind but a server log:
 * the child saw their mark, the report card never got it, and a retry was
 * refused as "changed since you marked it". Nobody could see the gap.
 *
 * Tutor-only. `toStudentSubmissionPayload` names its fields and never reads
 * this one.
 */
export interface CaSyncRecord {
  status: "written" | "skipped" | "failed";
  /** Set when skipped: why, in the same words the sync itself uses. */
  reason?: CaSkipReason;
  /** The column it went to, when written. */
  assessmentTypeId?: string;
  /** The percentage sent, when written. */
  percentage?: number;
  at: number;
}

/**
 * Should the tutor be offered "Send to report card again" for this row?
 *
 * Failed: always, the send never happened. Skipped: yes, because the usual
 * cause (no column chosen yet, a column removed in ResultPeak) is fixed by a
 * school admin later, and a mark released before the fix would otherwise never
 * travel. `nothing_released` is excluded because there is nothing to send.
 * Written, or never attempted (released before this record existed): no.
 */
export function caNeedsResend(record: CaSyncRecord | null | undefined): boolean {
  if (!record) return false;
  if (record.status === "failed") return true;
  return record.status === "skipped" && record.reason !== "nothing_released";
}
