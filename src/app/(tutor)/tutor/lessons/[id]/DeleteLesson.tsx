"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Permanent delete: the lesson, its study guide, and its read receipts. */
export default function DeleteLesson({
  lessonId,
  lessonTitle,
}: {
  lessonId: string;
  lessonTitle: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (
      !window.confirm(
        `Delete "${lessonTitle}"? This removes the lesson, its study guide, and its reading records for good. Students will no longer see it.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lessons/${lessonId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't delete this lesson.");
      router.push("/tutor");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't delete this lesson.");
      setBusy(false);
    }
  }

  return (
    <section className="mt-12 rounded-lg border border-flagSoft p-4">
      <h2 className="text-sm font-medium text-flag">Delete this lesson</h2>
      <p className="mt-1 text-xs text-slate">
        Removes the lesson and its study guide for good. This cannot be undone.
      </p>
      {error && (
        <p className="mt-3 rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">{error}</p>
      )}
      <button
        onClick={remove}
        disabled={busy}
        className="mt-3 rounded-lg border border-flag px-4 py-2 text-sm font-medium text-flag disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Delete lesson"}
      </button>
    </section>
  );
}
