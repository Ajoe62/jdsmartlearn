"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Delete an assignment nobody has answered yet, or hide one they have.
 *
 * The server decides which applies (409 `has_submissions`); `hasSubmissions`
 * only chooses which button to show first. Hiding keeps every submission and mark.
 */
export default function DeleteAssignment({
  assignmentId,
  title,
  hasSubmissions,
  isActive,
}: {
  assignmentId: string;
  title: string;
  hasSubmissions: boolean;
  isActive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(hasSubmissions);
  const [hidden, setHidden] = useState(!isActive);

  const url = `/api/tutor/assignments/${encodeURIComponent(assignmentId)}`;

  async function remove() {
    if (
      !window.confirm(
        `Delete "${title}"? This removes the assignment and its question sheet for good. Students will no longer see it.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (res.status === 409 && data.code === "has_submissions") {
        setBlocked(true);
        setError(data.error ?? null);
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "We couldn't delete this assignment.");
      router.push("/tutor/assignments");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't delete this assignment.");
      setBusy(false);
    }
  }

  async function hide() {
    if (!window.confirm(`Hide "${title}" from students? Work already sent and marks are kept.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't hide this assignment.");
      setHidden(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't hide this assignment.");
    }
    setBusy(false);
  }

  return (
    <section className="mt-12 rounded-lg border border-dangerSoft p-4">
      <h2 className="text-sm font-medium text-danger">
        {blocked ? "Hide this assignment" : "Delete this assignment"}
      </h2>
      <p className="mt-1 text-xs text-muted">
        {blocked
          ? "Students have already sent work, so this assignment can't be deleted. Hiding it stops students seeing it and keeps their work and marks."
          : "Removes the assignment and its question sheet for good. This cannot be undone."}
      </p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-dangerSoft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {blocked ? (
        hidden ? (
          <p className="mt-3 text-sm text-muted">Hidden from students.</p>
        ) : (
          <button
            onClick={hide}
            disabled={busy}
            className="mt-3 rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger disabled:opacity-50"
          >
            {busy ? "Hiding…" : "Hide from students"}
          </button>
        )
      ) : (
        <button
          onClick={remove}
          disabled={busy}
          className="mt-3 rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete assignment"}
        </button>
      )}
    </section>
  );
}
