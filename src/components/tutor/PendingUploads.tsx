"use client";

import { useEffect, useState } from "react";
import type { QueuedOp } from "@/lib/offline/collapse";
import {
  discard,
  flushTutorOutbox,
  onQueueChange,
  queued,
} from "@/lib/offline/tutor-outbox";

/**
 * What the tutor sees about work done offline.
 *
 * Renders nothing when the queue is empty, which is almost always. Two states
 * matter: work waiting to upload, and work the server refused. The second must
 * never be silent - a teacher who wrote a lesson deserves to know it didn't land,
 * in the server's own words.
 */
export default function PendingUploads() {
  const [rows, setRows] = useState<QueuedOp[]>([]);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const load = () => void queued().then(setRows);
    load();

    setOnline(navigator.onLine);
    const up = () => {
      setOnline(true);
      load();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    const stop = onQueueChange(load);

    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      stop();
    };
  }, []);

  if (rows.length === 0) return null;

  const waiting = rows.filter((r) => r.state !== "failed");
  const stuck = rows.filter((r) => r.state === "failed");

  return (
    <div className="mx-auto max-w-readable px-5 pt-6">
      {waiting.length > 0 && (
        <div className="rounded-lg border border-line bg-paper p-4">
          <p className="text-sm font-medium">
            {online
              ? `Uploading ${waiting.length} ${waiting.length === 1 ? "change" : "changes"}…`
              : `${waiting.length} ${waiting.length === 1 ? "change is" : "changes are"} saved on your phone`}
          </p>
          <p className="mt-1 text-sm text-slate">
            {online
              ? "This finishes on its own. You can keep working."
              : "They will upload when you're back online."}
          </p>
          <ul className="mt-3 space-y-1 text-sm text-slate">
            {waiting.map((r) => (
              <li key={r.id}>
                {r.label}
                {r.op.kind === "create" && <> &mdash; {r.op.title}</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {stuck.length > 0 && (
        <div className="mt-3 rounded-lg border border-flag bg-flagSoft p-4">
          <p className="text-sm font-medium text-flag">
            {stuck.length === 1
              ? "1 change couldn't be uploaded"
              : `${stuck.length} changes couldn't be uploaded`}
          </p>
          <ul className="mt-3 space-y-3">
            {stuck.map((r) => (
              <li key={r.id} className="text-sm">
                <p className="font-medium">
                  {r.label}
                  {r.op.kind === "create" && <> &mdash; {r.op.title}</>}
                </p>
                {/* The server's own words - it knows why, we don't. */}
                {r.error && <p className="mt-0.5 text-slate">{r.error}</p>}
                <div className="mt-2 flex gap-3">
                  <button
                    type="button"
                    onClick={() => void flushTutorOutbox()}
                    className="font-medium text-marker underline"
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={() => r.id !== undefined && void discard(r.id)}
                    className="text-slate underline"
                  >
                    Discard it
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
