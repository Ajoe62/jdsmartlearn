"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CONTROL } from "@/components/ui/Field";
import { weekLabel } from "@/lib/notes/group";
import { MAX_WEEK } from "@/types";

/**
 * "Move to a week" for a topic note that has none yet (owner's request,
 * 2026-10-13). The teacher decides where it belongs once they know.
 *
 * Posts to the SAME PATCH /api/lessons/{id} the lesson page uses, which already
 * accepts a week and re-checks the class and subject. `baseUpdatedAt` makes it
 * refuse with 409 if the lesson changed since this page loaded, rather than
 * move a version the teacher has not seen.
 *
 * Online only: the subject page is not saved on the phone, so there is no
 * offline case to queue for here.
 */
export default function MoveToWeek({
  lessonId,
  updatedAt,
}: {
  lessonId: string;
  updatedAt: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [week, setWeek] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move() {
    if (!week) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lessons/${encodeURIComponent(lessonId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week: Number(week), baseUpdatedAt: updatedAt }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Couldn't move this lesson. Try again.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("You're offline. Connect and try again.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Move to a week
      </Button>
    );
  }

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`move-${lessonId}`} className="sr-only">
          Week
        </label>
        <select
          id={`move-${lessonId}`}
          value={week}
          onChange={(e) => setWeek(e.target.value)}
          className={`${CONTROL} min-h-[44px] w-auto flex-1`}
          disabled={busy}
        >
          <option value="">Choose a week</option>
          {Array.from({ length: MAX_WEEK }, (_, i) => i + 1).map((w) => (
            <option key={w} value={w}>
              {weekLabel(w)}
            </option>
          ))}
        </select>
        <Button onClick={move} disabled={!week || busy}>
          {busy ? "Moving…" : "Move"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
