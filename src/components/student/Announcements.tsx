"use client";

import { useEffect, useState } from "react";
import AnnouncementCard from "@/components/ui/AnnouncementCard";
import { Button } from "@/components/ui/Button";
import { dismiss, getAnnouncements, getReadState } from "@/lib/offline/announcements";
import {
  isUnread,
  sortNotices,
  type NoticeItem,
  type ReadState,
} from "@/lib/announcements/notices";
import { onSyncProgress } from "@/lib/offline/sync";

/**
 * School announcements on the student dashboard, rendered by BOTH paths:
 *
 *  - online first visit: the server passes `initial` from the cached bundle
 *  - offline / repeat:    this reads IndexedDB
 *
 * One component, so the two paths cannot drift - the same rule DashboardView
 * follows. Nothing here can hold personal data: the shape is NoticeItem, which
 * has no field for a name, a mark, or an author uid.
 *
 * HOW MANY ARE SHOWN, AND WHY IT IS NOT ALL OF THEM. Unread notices always show,
 * however many there are - that is the feature. Read ones collapse behind a
 * "show earlier" toggle, because a term's worth of old notices above the subject
 * list would push the lessons off a 360px screen, and the lessons are what the
 * child opened the app for.
 */
export default function Announcements({
  initial,
  initialReadState,
}: {
  initial: NoticeItem[];
  initialReadState: ReadState;
}) {
  const [items, setItems] = useState<NoticeItem[]>(initial);
  const [state, setState] = useState<ReadState>(initialReadState);
  const [showRead, setShowRead] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Re-read the device store after every sync, and on mount when the server gave
  // us nothing (the offline shell).
  useEffect(() => {
    let alive = true;

    const load = async () => {
      const [rows, saved] = await Promise.all([getAnnouncements(), getReadState()]);
      if (!alive) return;
      // Only replace the server copy once the device actually has something.
      // A first visit renders from `initial` and must not blank on an empty store.
      if (rows.length > 0) {
        setItems(sortNotices(rows));
        setState(saved);
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

  async function onDismiss(id: string) {
    setBusy(id);
    // dismiss() applies it locally first, so this resolves even on a dead link.
    const next = await dismiss(id);
    setState(next);
    setBusy(null);
  }

  const unread = items.filter((n) => isUnread(n, state));
  const read = items.filter((n) => !isUnread(n, state));

  if (items.length === 0) return null;

  return (
    <section className="mt-6" aria-labelledby="announcements-heading">
      <h2 id="announcements-heading" className="sr-only">
        Announcements from your school
      </h2>

      <div className="space-y-3">
        {unread.map((n) => (
          <AnnouncementCard
            key={n.id}
            {...n}
            unread
            action={
              <Button
                variant="secondary"
                onClick={() => void onDismiss(n.id)}
                disabled={busy === n.id}
              >
                {busy === n.id ? "Saving…" : "Got it"}
              </Button>
            }
          />
        ))}
      </div>

      {read.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowRead((v) => !v)}
            className="min-h-[44px] text-sm font-medium text-accentText underline"
          >
            {showRead
              ? "Hide earlier announcements"
              : `Earlier announcements (${read.length})`}
          </button>

          {showRead && (
            <div className="mt-3 space-y-3">
              {read.map((n) => (
                <AnnouncementCard key={n.id} {...n} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

