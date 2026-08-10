"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STORE, getAll } from "@/lib/offline/db";
import type { QueuedSubmission, StoredAssignment, StoredSubmission } from "@/lib/offline/db";
import { discardSubmission, queuedSubmissions } from "@/lib/offline/submissions";
import { ASSIGNMENT_TABS, IN_PROGRESS_STATUSES } from "@/types/student-dashboard";
import type {
  AssignmentListItem,
  AssignmentTab,
  SubmissionStatus,
} from "@/types/student-dashboard";

/**
 * The student's assignments, rendered by BOTH paths:
 *
 *  - online first visit: the server passes `initial`
 *  - offline / repeat:    this reads IndexedDB and replaces it
 *
 * One component, so the two paths cannot drift. Same arrangement as
 * DashboardView. Nothing here can hold a marking guide; the shape has no field.
 *
 * The tab lives in the URL, not in state, so the back button steps between tabs
 * the way a student expects on a phone.
 */
export default function AssignmentsView({
  initial,
  tab,
}: {
  initial: AssignmentListItem[] | null;
  tab: AssignmentTab;
}) {
  const [items, setItems] = useState<AssignmentListItem[] | null>(initial);
  const [waiting, setWaiting] = useState<QueuedSubmission[]>([]);

  useEffect(() => {
    let alive = true;

    void (async () => {
      const queued = await queuedSubmissions();
      if (alive) setWaiting(queued);

      try {
        const [assignments, submissions] = await Promise.all([
          getAll<StoredAssignment>(STORE.assignments),
          getAll<StoredSubmission>(STORE.submissions),
        ]);
        if (!alive || assignments.length === 0) return;

        const byId = new Map(submissions.map((s) => [s.assignmentId, s]));
        const now = Date.now();

        setItems(
          assignments
            .map((a): AssignmentListItem => {
              const sub = byId.get(a.assignmentId) ?? null;
              const status = (sub?.status ?? null) as SubmissionStatus | null;
              const finalScore = status === "finalised" ? (sub?.finalScore ?? null) : null;
              return {
                assignmentId: a.assignmentId,
                title: a.title,
                subjectId: a.subjectId,
                subjectName: a.subjectName,
                type: a.type as AssignmentListItem["type"],
                dueDate: a.dueDate,
                maxMarks: a.maxMarks,
                status,
                submittedAt: sub?.submittedAt ?? null,
                finalScore,
                percentage:
                  finalScore === null || a.maxMarks === 0
                    ? null
                    : Math.round((finalScore / a.maxMarks) * 100),
                isOverdue: sub === null && a.dueDate < now,
              };
            })
            .sort((a, b) => a.dueDate - b.dueDate)
        );
      } catch {
        // No device store (private mode, old browser). The server copy stands.
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const all = items ?? [];
  const shown = all.filter((item) => inTab(item, tab));
  const titleFor = (assignmentId: string) =>
    all.find((a) => a.assignmentId === assignmentId)?.title ?? "Your work";

  async function discard(assignmentId: string) {
    await discardSubmission(assignmentId);
    setWaiting(await queuedSubmissions());
  }

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/student" className="text-sm text-slate">
        Back to your subjects
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">Your work</h1>

      <nav className="mt-5 flex gap-2" aria-label="Assignment status">
        {ASSIGNMENT_TABS.map((name) => {
          const count = all.filter((item) => inTab(item, name)).length;
          const active = name === tab;
          return (
            <Link
              key={name}
              href={`/student/assignments?tab=${name}`}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "rounded-lg bg-marker px-3 py-2 text-sm font-medium text-chalk"
                  : "rounded-lg border border-line bg-chalk px-3 py-2 text-sm text-slate"
              }
            >
              {TAB_LABELS[name]}
              {count > 0 ? ` (${count})` : ""}
            </Link>
          );
        })}
      </nav>

      {/*
        Work sitting on the phone. Shown on every tab, because a child who cannot
        find the assignment they answered will answer it again. A rejection is
        never dropped silently: the server's own words, and a way to clear it.
      */}
      {waiting.length > 0 && (
        <ul className="mt-5 space-y-2">
          {waiting.map((row) => (
            <li
              key={row.assignmentId}
              className="rounded-lg border border-line bg-paper p-4 text-sm"
            >
              <p className="font-medium">{titleFor(row.assignmentId)}</p>
              {row.error ? (
                <>
                  <p className="mt-1">{row.error}</p>
                  <button
                    type="button"
                    onClick={() => void discard(row.assignmentId)}
                    className="mt-2 font-medium text-marker"
                  >
                    Clear this
                  </button>
                </>
              ) : (
                <p className="mt-1 text-slate">
                  Saved on your phone. It sends to your teacher when you have internet.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {shown.length === 0 ? (
        <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
          {EMPTY[tab]}
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {shown.map((item) => (
            <li key={item.assignmentId}>
              <Link
                href={`/student/assignments/${item.assignmentId}`}
                className="block rounded-lg border border-line bg-chalk p-4 hover:border-marker"
              >
                <p className="font-medium">{item.title}</p>
                <p className="mt-1 text-sm text-slate">{item.subjectName}</p>

                {tab === "pending" && (
                  <p className="mt-2 text-sm">
                    {item.isOverdue ? (
                      /* Plain red text, not a badge. A badge reads as decoration
                         at a glance; this needs to read as a fact. */
                      <span className="font-medium text-red-700">
                        Overdue. Was due {dateText(item.dueDate)}
                      </span>
                    ) : (
                      <span className="text-slate">Due {dateText(item.dueDate)}</span>
                    )}
                    <span className="text-slate"> &middot; {item.maxMarks} marks</span>
                  </p>
                )}

                {tab === "submitted" && (
                  <p className="mt-2 text-sm text-slate">
                    Sent {dateText(item.submittedAt ?? item.dueDate)} &middot;{" "}
                    {STATUS_TEXT[item.status ?? "submitted"]}
                  </p>
                )}

                {tab === "graded" && (
                  <p className="mt-2 text-sm">
                    <span className="font-medium">
                      {item.finalScore} / {item.maxMarks}
                    </span>
                    {item.percentage !== null && (
                      <span className="text-slate"> &middot; {item.percentage}%</span>
                    )}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function inTab(item: AssignmentListItem, tab: AssignmentTab): boolean {
  if (tab === "pending") return item.status === null;
  if (tab === "graded") return item.status === "finalised";
  return item.status !== null && IN_PROGRESS_STATUSES.includes(item.status);
}

const TAB_LABELS: Record<AssignmentTab, string> = {
  pending: "To do",
  submitted: "Sent",
  graded: "Marked",
};

const EMPTY: Record<AssignmentTab, string> = {
  pending: "Nothing to do right now. Your teacher will set work here.",
  submitted: "Nothing waiting to be marked. Work you send appears here.",
  graded: "No marks yet. Your teacher marks your work before you see a score.",
};

/**
 * What a student is told while their work is being marked.
 *
 * Never mentions the AI having produced a score. The mark does not exist for
 * them until their teacher releases it, and saying otherwise invites them to ask
 * for a number their teacher has not agreed to.
 */
const STATUS_TEXT: Record<SubmissionStatus, string> = {
  submitted: "Waiting to be marked",
  ai_grading: "Being marked",
  ai_graded: "Waiting for your teacher",
  ai_grading_failed: "Waiting for your teacher",
  teacher_reviewed: "Waiting for your teacher",
  finalised: "Marked",
};

/** Short and plain. A student needs the day, not a timestamp. */
function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
