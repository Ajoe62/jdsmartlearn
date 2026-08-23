"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Badge from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

/**
 * One uploaded scheme of work, with its publish switch.
 *
 * ONE switch, unlike a lesson's two. A lesson separates the raw material from
 * the AI study guide because the guide needs teacher review before a child sees
 * it. A scheme has no generated half, so a second switch would be a control with
 * nothing behind it.
 */
export default function SchemeRow({
  id,
  subjectName,
  title,
  term,
  session,
  published,
}: {
  id: string;
  subjectName: string;
  title: string;
  term: string | null;
  session: string | null;
  published: boolean;
}) {
  const router = useRouter();
  const [live, setLive] = useState(published);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/schemes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ published: !live }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "We couldn't change that. Try again.");
        return;
      }
      setLive(!live);
      router.refresh();
    } catch {
      setError("We couldn't reach the internet. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-medium">{subjectName}</p>
        <p className="mt-0.5 truncate text-sm text-muted">
          {title} &middot; {termLabel(term, session)}
        </p>
        {error && (
          <p className="mt-1 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge tone={live ? "success" : "neutral"}>{live ? "Students see it" : "Draft"}</Badge>
        <Button variant="secondary" onClick={() => void toggle()} disabled={busy}>
          {busy ? "Saving…" : live ? "Take down" : "Publish"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Both strings or neither. "Second Term" alone spans every year the school has
 * run, and a scheme with no stamp says "Not filed under a term" rather than
 * being placed in a guess.
 */
function termLabel(term: string | null, session: string | null): string {
  if (term === null || session === null) return "Not filed under a term";
  return `${term}, ${session}`;
}
