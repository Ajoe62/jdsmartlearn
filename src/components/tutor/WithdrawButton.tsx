"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Take an announcement down.
 *
 * Two taps, not one. A single-tap delete on a list of similar-looking cards is
 * how a school withdraws the wrong notice, and there is no undo: the document is
 * deleted rather than flagged (see deleteNotice) precisely so a withdrawn notice
 * cannot come back.
 */
export default function WithdrawButton({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tutor/announcements?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "We couldn't take that down. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("We couldn't reach the internet. Nothing was changed.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (error) {
    return (
      <span className="text-sm text-danger" role="alert">
        {error}
      </span>
    );
  }

  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Take down
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <Button variant="danger" onClick={() => void withdraw()} disabled={busy}>
        {busy ? "Taking down…" : "Yes, take it down"}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
        Keep it
      </Button>
    </span>
  );
}
