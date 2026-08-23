"use client";

import { useState } from "react";
import AnnouncementCard from "@/components/ui/AnnouncementCard";
import { Button } from "@/components/ui/Button";
import { isUnread, type NoticeItem, type ReadState } from "@/lib/announcements/notices";

/**
 * Announcements on the teacher dashboard.
 *
 * Simpler than the student twin, and deliberately so: tutor pages are
 * network-only by the service worker's deny-list (they render marking guides and
 * live access codes), so there is no device store to read from and no queue to
 * flush. A dismissal here is one request, and a failed one leaves the card up -
 * which is the honest outcome, since the card is what says the notice is unread.
 *
 * Read notices are not shown at all here. A teacher's dashboard is a work queue;
 * the student's keeps its history because a child needs to look up the
 * resumption date again, and a teacher would go to the composer for that.
 */
export default function TutorNotices({
  initial,
  initialReadState,
}: {
  initial: NoticeItem[];
  initialReadState: ReadState;
}) {
  const [state, setState] = useState<ReadState>(initialReadState);
  const [busy, setBusy] = useState<string | null>(null);

  const unread = initial.filter((n) => isUnread(n, state));
  if (unread.length === 0) return null;

  async function onDismiss(id: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/tutor/announcements/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ids: [id] }),
      });
      if (res.ok) setState((await res.json()) as ReadState);
    } catch {
      // Left up. The teacher can tap again; nothing was lost.
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-6 space-y-3" aria-labelledby="tutor-notices-heading">
      <h2 id="tutor-notices-heading" className="sr-only">
        Announcements from your school
      </h2>
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
    </section>
  );
}
