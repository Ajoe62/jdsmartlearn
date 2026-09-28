"use client";

import { useEffect, useState } from "react";
import { getMeta } from "@/lib/offline/db";
import { onSyncProgress } from "@/lib/offline/sync";
import { resultPeakStudentPhotoUrl } from "@/lib/partner-links";

/**
 * The child's passport photo at the top of their dashboard, with the way to add
 * or change it.
 *
 * Rendered by both paths, like the rest of DashboardView. Online first visit:
 * the server passes `initialPhotoUrl` from the session. Every visit after: the
 * service worker serves the data-free shell and the address comes from the
 * device store, where the last sync put it. The bytes come from the service
 * worker's own photo bucket, so the photo still shows with no signal.
 *
 * NO UPLOAD HERE, AND THERE MUST NEVER BE ONE. The link goes to ResultPeak,
 * which owns the photo and where the school approves it (CLAUDE.md, Student
 * photo rules). A pending photo is never shown in this product: this card only
 * ever knows about the approved one.
 */
export default function StudentPhotoCard({
  initialPhotoUrl = null,
  changeUrl,
}: {
  initialPhotoUrl?: string | null;
  /**
   * The server passes the school's own results domain when it has one. The
   * offline shell cannot, so it falls back to the configured deployment. "" when
   * ResultPeak is not configured at all, and then no link is drawn.
   */
  changeUrl?: string;
}) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(initialPhotoUrl);
  const [failed, setFailed] = useState(false);
  const link = changeUrl ?? resultPeakStudentPhotoUrl();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const meta = await getMeta();
        // No store yet (the very first visit, before a sync): keep what the
        // server said. Once a store exists it is the truth, absence included.
        if (!alive || !meta) return;
        setPhotoUrl(meta.photoUrl ?? null);
        setFailed(false);
      } catch {
        // No device store (private mode, old browser). The server value stands.
      }
    };
    void load();
    const stop = onSyncProgress((p) => {
      if (p.phase === "done") void load();
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const show = photoUrl && !failed;

  return (
    <section className="mb-6 flex items-center gap-4 rounded-xl border border-line bg-surface p-4 shadow-card">
      {/* 7:9, the passport rectangle. Never a circle: this is the photo the
          school prints on a report card, and cropping it here would make the
          two disagree. */}
      <div className="h-[72px] w-14 shrink-0 overflow-hidden rounded-md border border-line bg-canvas">
        {show ? (
          // A plain <img>: next/image would proxy it through an optimiser that
          // is neither private nor wiped with the device store.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt="Your photo"
            width={56}
            height={72}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <Silhouette />
        )}
      </div>

      <div className="min-w-0 text-sm">
        <p className="font-medium text-ink">{show ? "Your photo" : "Add your passport photo"}</p>
        {!show && (
          <p className="mt-0.5 text-muted">
            Your school checks it before it shows here and on your report card.
          </p>
        )}
        {link && (
          <a
            className="mt-1 inline-flex min-h-[44px] items-center font-medium underline"
            href={link}
            rel="noopener noreferrer"
            target="_blank"
          >
            {show ? "Change photo" : "Add photo"}
          </a>
        )}
      </div>
    </section>
  );
}

/** Neutral head-and-shoulders placeholder. Never a blank box, never a broken image. */
function Silhouette() {
  return (
    <svg viewBox="0 0 56 72" className="h-full w-full text-lineStrong" aria-hidden>
      <circle cx="28" cy="27" r="11" fill="currentColor" />
      <path d="M6 72c0-14 10-23 22-23s22 9 22 23z" fill="currentColor" />
    </svg>
  );
}
