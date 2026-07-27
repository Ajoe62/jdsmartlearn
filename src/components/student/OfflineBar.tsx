"use client";

import { useEffect, useState } from "react";
import { onSyncProgress, sync, type SyncProgress } from "@/lib/offline/sync";

/**
 * The only persistent offline affordance. It appears ONLY when there is
 * something to say - a permanent connection indicator is noise on a network
 * that drops all day.
 *
 * Copy avoids the word "cache": a student has lessons "saved on your phone".
 */
export default function OfflineBar() {
  const [online, setOnline] = useState(true);
  const [progress, setProgress] = useState<SyncProgress>({
    phase: "idle",
    done: 0,
    total: 0,
    lastSyncAt: null,
  });

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const stop = onSyncProgress(setProgress);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      stop();
    };
  }, []);

  const syncing = progress.phase === "index" || progress.phase === "guides";

  if (syncing) {
    return (
      <Bar tone="busy">
        {progress.total > 0
          ? `Saving your lessons… ${progress.done} of ${progress.total}`
          : "Checking for new lessons…"}
      </Bar>
    );
  }

  if (!online) {
    return <Bar tone="quiet">You&rsquo;re offline. Showing your saved lessons.</Bar>;
  }

  if (progress.phase === "error" && progress.message) {
    return (
      <Bar tone="warn">
        <span>{progress.message}</span>
        <button
          type="button"
          onClick={() => void sync({ force: true })}
          className="shrink-0 font-semibold underline"
        >
          Try again
        </button>
      </Bar>
    );
  }

  return null;
}

function Bar({
  tone,
  children,
}: {
  tone: "quiet" | "busy" | "warn";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "warn"
      ? "bg-amber-50 text-amber-900"
      : tone === "busy"
        ? "bg-markerSoft text-marker"
        : "bg-paper text-slate";

  return (
    <div role="status" aria-live="polite" className={`border-b border-line ${toneClass}`}>
      <div className="mx-auto flex max-w-readable items-center justify-between gap-3 px-5 py-2 text-sm">
        {children}
      </div>
    </div>
  );
}
