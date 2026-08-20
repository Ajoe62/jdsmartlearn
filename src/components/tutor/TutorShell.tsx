"use client";

import { useEffect, useState } from "react";
import { ensureTutorOwner } from "@/lib/offline/tutor-db";
import { flushTutorOutbox, watchTutorConnection } from "@/lib/offline/tutor-outbox";
import PendingUploads from "./PendingUploads";

/**
 * Tutor offline lifecycle, mounted once by the tutor layout.
 *
 *   1. wipe if a different tutor last used this phone, or the store outlived the
 *      5-day session (it may hold marking guides)
 *   2. flush anything queued
 *   3. watch for reconnect
 */
export default function TutorShell({ uid }: { uid: string }) {
  const [wipedNotice, setWipedNotice] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { wiped } = await ensureTutorOwner(uid);
      if (cancelled) return;
      // Queued work was discarded with the store. Say so - it would otherwise
      // look like the lessons uploaded.
      if (wiped) setWipedNotice(true);
      void flushTutorOutbox();
    })();

    const stop = watchTutorConnection();
    return () => {
      cancelled = true;
      stop();
    };
  }, [uid]);

  return (
    <>
      {wipedNotice && (
        <div className="mx-auto max-w-readable px-5 pt-6">
          <div className="rounded-lg border border-line bg-canvas p-4 text-sm">
            <p className="font-medium">Saved changes on this phone were cleared</p>
            <p className="mt-1 text-muted">
              This phone was last used by a different teacher, or the sign-in expired.
              Anything not yet uploaded is gone.
            </p>
          </div>
        </div>
      )}
      <PendingUploads />
    </>
  );
}
