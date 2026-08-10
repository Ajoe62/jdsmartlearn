/**
 * Finding and retrying submissions whose grading never happened.
 *
 * PURE. No Firestore, no `server-only`, no `next/*`, for the same reason as
 * `ca.ts`: these rules decide whether a school's Gemini quota gets spent again,
 * so they must be directly testable.
 *
 * WHY THIS EXISTS. The grading trigger is a fetch that outlives its request via
 * `waitUntil`. That is far more reliable than the bare `void fetch(...)` it
 * replaced, but it is not a queue. A cold start, a deploy mid-flight, a 500 from
 * the grading route, or a Gemini timeout all leave a submission stuck. The
 * failure is invisible: a stuck submission looks exactly like one that has not
 * been marked yet.
 *
 * WHY NOT CRON. Vercel Hobby runs cron at most once a day, which is useless
 * inside a school day. This is pull-on-demand instead: the sweep runs when a
 * tutor opens the page that would show the result, which is precisely when
 * someone cares.
 */

/** What the sweep needs to judge one row. A subset of AssignmentSubmission. */
export interface SweepCandidate {
  id: string;
  status: string;
  submittedAt: number;
  gradingAttempts: number;
  lastGradingAttemptAt: number;
}

/**
 * Statuses a sweep may act on.
 *
 *   "ai_grading"  a trigger fired and never reported back. Retry.
 *   "submitted"   no trigger ever fired. Retry, because the cause may since
 *                 have been fixed (INTERNAL_TASK_SECRET added, for instance).
 *
 * Everything past these is finished or deliberately parked and must be left
 * alone: `ai_graded` is waiting for a tutor, `teacher_reviewed` and `finalised`
 * are the tutor's, and `ai_grading_failed` has already exhausted its attempts.
 */
export const SWEEPABLE_STATUSES = ["submitted", "ai_grading"] as const;

/**
 * How many times one submission may be sent for marking.
 *
 * Three, total, including the attempt made at submission time. A submission that
 * fails deterministically, an unreadable photo or a marking guide the model
 * cannot work with, must stop spending a school's shared free-tier quota. After
 * the cap it becomes `ai_grading_failed` and belongs to the tutor.
 */
export const GRADING_ATTEMPT_CAP = 3;

/** Minutes before a stuck submission may be retried. Env-tunable, default 10. */
export function staleThresholdMs(): number {
  const raw = Number(process.env.GRADING_STALE_MINUTES ?? 10);
  if (!Number.isFinite(raw) || raw <= 0) return 10 * 60_000;
  return raw * 60_000;
}

export interface SweepOptions {
  now: number;
  thresholdMs: number;
  cap: number;
}

/** True when this row is genuinely stuck rather than still in flight. */
export function isStuck(row: SweepCandidate, opts: SweepOptions): boolean {
  if (!(SWEEPABLE_STATUSES as readonly string[]).includes(row.status)) return false;
  // Already given every chance it gets.
  if (row.gradingAttempts >= opts.cap) return false;
  // Still in flight. Grading takes twenty to forty seconds; the threshold is
  // minutes, so anything inside it is presumed running rather than lost.
  return opts.now - row.lastGradingAttemptAt >= opts.thresholdMs;
}

/** Rows worth retrying, oldest first so the longest wait is served first. */
export function selectStuck(
  rows: SweepCandidate[],
  opts: SweepOptions
): SweepCandidate[] {
  return rows
    .filter((row) => isStuck(row, opts))
    .sort((a, b) => a.lastGradingAttemptAt - b.lastGradingAttemptAt);
}

/**
 * Rows that have exhausted their attempts and are still not marked.
 *
 * These need their status moved to `ai_grading_failed` so a tutor sees that the
 * work is theirs to mark, rather than a row that quietly stopped being retried
 * and still says it is being marked.
 */
export function selectExhausted(
  rows: SweepCandidate[],
  opts: Pick<SweepOptions, "cap">
): SweepCandidate[] {
  return rows.filter(
    (row) =>
      (SWEEPABLE_STATUSES as readonly string[]).includes(row.status) &&
      row.gradingAttempts >= opts.cap
  );
}
