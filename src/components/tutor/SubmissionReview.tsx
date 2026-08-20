"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { formatBytes } from "@/lib/format";
import { queueMark } from "@/lib/offline/tutor-marks";
import { GRADING_ATTEMPT_CAP, SWEEPABLE_STATUSES } from "@/lib/assessment/grading-recovery";
import type { SubmissionFilter, TutorSubmissionRow } from "@/types/student-dashboard";

/**
 * Marking, as an inline expand rather than a slide-over.
 *
 * A slide-over on a 360px screen is a full-screen panel with extra animation;
 * an expanding row keeps the tutor's place in the list and costs no JS to
 * animate. Only one row is open at a time.
 *
 * This component renders the marking guide. It is tutor-only, and the route it
 * lives on is network-only forever (see the page's comment).
 */

interface Detail {
  content: string;
  attachments: { name: string; size: number; href: string }[];
  aiFeedback: string | null;
  aiStrengths: string[] | null;
  aiImprovements: string[] | null;
  teacherComment: string | null;
}

const FILTERS: { id: SubmissionFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending_review", label: "To review" },
  { id: "finalised", label: "Released" },
];

export default function SubmissionReview({
  maxMarks,
  markingGuide,
  rows,
  details,
}: {
  maxMarks: number;
  markingGuide: string;
  rows: TutorSubmissionRow[];
  details: Record<string, Detail>;
}) {
  const [filter, setFilter] = useState<SubmissionFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const shown = rows.filter((r) => {
    if (filter === "finalised") return r.status === "finalised";
    if (filter === "pending_review") return r.status !== "finalised";
    return true;
  });

  return (
    <>
      <section className="mt-6 rounded-lg border border-line bg-canvas p-4">
        <h2 className="text-sm font-semibold">Your marking guide</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{markingGuide}</p>
        <p className="mt-2 text-xs text-muted">Only you can see this.</p>
      </section>

      <nav className="mt-6 flex gap-2" aria-label="Filter submissions">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={
              filter === f.id
                ? "rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white"
                : "rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted"
            }
          >
            {f.label}
          </button>
        ))}
      </nav>

      {shown.length === 0 ? (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
          {filter === "finalised"
            ? "Nothing released yet."
            : rows.length === 0
              ? "No work has come in yet. Students see this assignment on their phones."
              : "Nothing left to review."}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {shown.map((row) => (
            <li key={row.submissionId} className="rounded-lg border border-line bg-surface">
              <button
                type="button"
                onClick={() =>
                  setOpenId(openId === row.submissionId ? null : row.submissionId)
                }
                aria-expanded={openId === row.submissionId}
                className="flex w-full items-center justify-between gap-3 p-4 text-left"
              >
                <span className="min-w-0">
                  <span className="block font-medium">
                    {row.username ?? "No username yet"}
                  </span>
                  <span className="mt-1 block text-sm text-muted">
                    Sent {new Date(row.submittedAt).toDateString()} &middot;{" "}
                    {statusText(row.status)}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm">
                  {row.status === "finalised" ? (
                    <span className="font-medium">
                      {row.finalScore} / {maxMarks}
                    </span>
                  ) : row.aiScore !== null ? (
                    <>
                      <span className="block text-muted">
                        AI {row.aiScore} / {maxMarks}
                      </span>
                      {row.aiConfidence && (
                        <span
                          className={
                            row.aiConfidence === "low"
                              ? "block text-xs text-warn"
                              : "block text-xs text-muted"
                          }
                        >
                          {row.aiConfidence} confidence
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted">Not marked</span>
                  )}
                </span>
              </button>

              {openId === row.submissionId && (
                <ReviewPanel
                  row={row}
                  detail={details[row.submissionId]}
                  maxMarks={maxMarks}
                  onDone={() => setOpenId(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ReviewPanel({
  row,
  detail,
  maxMarks,
  onDone,
}: {
  row: TutorSubmissionRow;
  detail: Detail | undefined;
  maxMarks: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const [score, setScore] = useState(
    row.teacherScore !== null ? String(row.teacherScore) : ""
  );
  const [comment, setComment] = useState(detail?.teacherComment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);

  const released = row.status === "finalised";

  async function retry() {
    setRetrying(true);
    setRetryNote(null);
    try {
      const res = await fetch("/api/tutor/grading-retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "submission", submissionId: row.submissionId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't ask again just now.");
      setRetryNote("Asked again. Refresh in a minute to see the mark.");
      router.refresh();
    } catch (err) {
      setRetryNote(err instanceof Error ? err.message : "We couldn't ask again just now.");
    } finally {
      setRetrying(false);
    }
  }

  async function save(action: "draft" | "finalise") {
    setBusy(true);
    setError(null);

    const payload = {
      submissionId: row.submissionId,
      action,
      teacherScore: score.trim() === "" ? null : Number(score),
      teacherComment: comment.trim() || null,
      // Carried so a mark saved offline days ago cannot clobber a newer one.
      baseUpdatedAt: row.updatedAt,
    };

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      const ok = await queueMark(payload);
      setBusy(false);
      if (!ok) {
        setError("This phone can't save marking offline. Connect and try again.");
        return;
      }
      setQueued(true);
      return;
    }

    try {
      const res = await fetch("/api/tutor/finalise-assignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't save that mark.");
      onDone();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't save that mark.");
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line p-4">
      <section>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
          What they wrote
        </h3>
        {detail?.content ? (
          <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-sm">
            {detail.content}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">They sent files only.</p>
        )}
      </section>

      {detail && detail.attachments.length > 0 && (
        <ul className="mt-3 space-y-2">
          {detail.attachments.map((file) => (
            <li key={file.href}>
              <a
                href={file.href}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2 text-sm hover:border-brand"
              >
                <span className="min-w-0 truncate">{file.name}</span>
                <span className="shrink-0 text-muted">{formatBytes(file.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {row.aiScore !== null && (
        <section className="mt-5 rounded-lg border border-line bg-canvas p-3">
          <h3 className="text-sm font-semibold">
            AI marked this {row.aiScore} out of {maxMarks}
            {row.aiConfidence ? `, ${row.aiConfidence} confidence` : ""}
          </h3>
          <p className="mt-1 text-xs text-muted">
            AI-generated. Review before releasing. Your student sees nothing until
            you release it.
          </p>
          {detail?.aiFeedback && <p className="mt-2 text-sm">{detail.aiFeedback}</p>}
          {detail?.aiStrengths && detail.aiStrengths.length > 0 && (
            <PlainList title="Did well" items={detail.aiStrengths} />
          )}
          {detail?.aiImprovements && detail.aiImprovements.length > 0 && (
            <PlainList title="To work on" items={detail.aiImprovements} />
          )}
        </section>
      )}

      {row.status === "ai_grading_failed" && (
        <p className="mt-5 rounded-lg border border-line bg-canvas p-3 text-sm">
          We tried to mark this and it did not work. Read it and give a mark yourself.
        </p>
      )}

      {/*
        Waiting to be marked, and the automatic attempt has not come back. The
        page already retries these quietly on load; this is for a tutor who does
        not want to wait for that. Capped, so a submission that fails every time
        cannot become a button that drains the school's quota.
      */}
      {(SWEEPABLE_STATUSES as readonly string[]).includes(row.status) && (
        <div className="mt-5 rounded-lg border border-line bg-canvas p-3 text-sm">
          {row.gradingAttempts >= GRADING_ATTEMPT_CAP ? (
            <p>
              We tried marking this {row.gradingAttempts} times and it did not work.
              Give it a mark yourself.
            </p>
          ) : (
            <>
              <p>This one is waiting to be marked.</p>
              <button
                type="button"
                disabled={retrying}
                onClick={() => void retry()}
                className="mt-2 font-medium text-brand disabled:opacity-60"
              >
                {retrying ? "Asking again" : "Retry marking"}
              </button>
              {retryNote && <p className="mt-2">{retryNote}</p>}
            </>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium">Your mark, out of {maxMarks}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={maxMarks}
            value={score}
            disabled={busy || released}
            onChange={(e) => setScore(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 disabled:opacity-60"
          />
        </label>

        {row.aiScore !== null && !released && (
          <button
            type="button"
            onClick={() => setScore(String(row.aiScore))}
            className="mt-6 h-11 rounded-lg border border-line bg-canvas px-4 font-medium text-brand"
          >
            Use AI mark
          </button>
        )}
      </div>

      <label className="mt-4 block">
        <span className="text-sm font-medium">Comment for the student (optional)</span>
        <textarea
          value={comment}
          rows={3}
          disabled={busy || released}
          onChange={(e) => setComment(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 disabled:opacity-60"
        />
      </label>

      {queued && (
        <p role="status" className="mt-4 rounded-lg border border-line bg-canvas p-3 text-sm">
          <span className="font-medium">Saved on this phone.</span> It sends to your
          students when you have internet.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-line bg-canvas p-3 text-sm">
          {error}
        </p>
      )}

      {released ? (
        <p className="mt-4 text-sm text-muted">
          Released on {row.finalScore !== null ? `${row.finalScore} / ${maxMarks}` : ""}.
          Your student can see this mark.
        </p>
      ) : (
        <div className="mt-5 flex flex-wrap gap-3">
          <Button disabled={busy} onClick={() => void save("finalise")}>
            Release to student
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void save("draft")}>
            Save without releasing
          </Button>
        </div>
      )}
    </div>
  );
}

function PlainList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
      <ul className="mt-1 space-y-0.5 text-sm">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_TEXT: Record<TutorSubmissionRow["status"], string> = {
  submitted: "waiting to be marked",
  ai_grading: "being marked",
  ai_graded: "marked, needs your review",
  ai_grading_failed: "mark it yourself",
  teacher_reviewed: "saved, not released",
  finalised: "released",
};

/**
 * A status this build has never seen lands on the tutor, which is the right
 * place for it: they can open the row and mark it by hand. The unchecked lookup
 * rendered nothing at all, which reads as a row with no state rather than one
 * needing attention.
 */
function statusText(status: TutorSubmissionRow["status"]): string {
  return STATUS_TEXT[status] ?? "needs your review";
}
