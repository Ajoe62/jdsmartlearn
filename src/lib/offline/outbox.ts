/**
 * The student write queue.
 *
 * Students generate exactly one kind of write: a read receipt. It is a soft
 * metric, so the design optimises for "never flood the shared quota" over
 * "never lose a count":
 *
 *  - at most ONE receipt per lesson per UTC day, deduped on the device, so the
 *    old behaviour of one Firestore write per page render is gone;
 *  - queued while offline, flushed in a single batched request on reconnect;
 *  - each flush carries a stable batchId the server dedupes on, so a lost
 *    response does not double-count.
 */

import { STORE, del, getAll, put, type OutboxView } from "./db";
import { dayKey } from "./merge";
import { MAX_VIEW_RECEIPTS as FLUSH_BATCH, OUTBOX_MAX_AGE_MS as MAX_AGE_MS } from "./config";

let flushing = false;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Record that this student opened a lesson.
 *
 * Deduplicated per (lesson, UTC day) on the device: opening the same lesson six
 * times today queues one receipt, not six. Silently does nothing when IndexedDB
 * is unavailable - a lost metric must never break a student's reading.
 */
export async function recordView(lessonId: string): Promise<void> {
  try {
    const today = dayKey();
    const rows = await getAll<OutboxView>(STORE.outbox);
    const already = rows.some(
      (r) => r.kind === "view" && r.lessonId === lessonId && r.dayKey === today
    );
    if (already) return;

    const entry: OutboxView = {
      kind: "view",
      lessonId,
      dayKey: today,
      count: 1,
      batchId: uuid(),
      state: "pending",
      createdAt: Date.now(),
    };
    await put(STORE.outbox, entry);
  } catch {
    // No store, no metric. Reading still works.
  }
}

export async function pendingCount(): Promise<number> {
  try {
    const rows = await getAll<OutboxView>(STORE.outbox);
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Send everything queued. Safe to call often - it no-ops when already running,
 * when offline, or when the queue is empty.
 */
export async function flush(): Promise<{ sent: number; kept: number }> {
  if (flushing) return { sent: 0, kept: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { sent: 0, kept: 0 };
  }

  flushing = true;
  try {
    let rows: OutboxView[];
    try {
      rows = await getAll<OutboxView>(STORE.outbox);
    } catch {
      return { sent: 0, kept: 0 };
    }

    // Drop stale entries before doing any work.
    const cutoff = Date.now() - MAX_AGE_MS;
    const expired = rows.filter((r) => r.createdAt < cutoff && r.id !== undefined);
    for (const r of expired) await del(STORE.outbox, r.id!).catch(() => {});

    const live = rows.filter((r) => r.createdAt >= cutoff && r.id !== undefined);
    if (live.length === 0) return { sent: 0, kept: 0 };

    let sent = 0;
    let kept = 0;

    for (let i = 0; i < live.length; i += FLUSH_BATCH) {
      const chunk = live.slice(i, i + FLUSH_BATCH);
      // One batchId for the whole request; the server stores it per receipt and
      // skips a repeat, so a retry after a lost response cannot double-count.
      const batchId = chunk[0].batchId;

      try {
        const res = await fetch("/api/student/views", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            batchId,
            views: chunk.map((r) => ({
              lessonId: r.lessonId,
              dayKey: r.dayKey,
              count: r.count,
            })),
          }),
        });

        if (res.ok) {
          for (const r of chunk) await del(STORE.outbox, r.id!).catch(() => {});
          sent += chunk.length;
          continue;
        }

        // 401 means the session lapsed; the receipts are worthless without one.
        // 4xx means the server rejected the shape - retrying will not help.
        if (res.status === 401 || (res.status >= 400 && res.status < 500)) {
          for (const r of chunk) await del(STORE.outbox, r.id!).catch(() => {});
          continue;
        }

        // 5xx or anything else: keep and try on the next reconnect.
        kept += chunk.length;
        break;
      } catch {
        kept += chunk.length;
        break;
      }
    }

    return { sent, kept };
  } finally {
    flushing = false;
  }
}
