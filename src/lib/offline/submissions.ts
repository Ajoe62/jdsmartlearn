/**
 * The student submission queue.
 *
 * Separate from `outbox.ts`, which carries read receipts, because the two have
 * opposite failure rules. A receipt is a soft metric and may be dropped to
 * protect the shared quota. A submission is a child's homework: it is never
 * dropped silently, and a terminal rejection is shown to them with the server's
 * own words rather than discarded.
 *
 * Text only. Attachments require a connection - see QueuedSubmission in db.ts.
 */

import { STORE, del, get, getAll, put } from "./db";
import type { QueuedSubmission, StoredDraft } from "./db";

const SYNC_TAG = "jd-submissions";

let flushing = false;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Queue an answer written offline. Returns false when the device has no store,
 * so the form can tell the student to connect instead of pretending it saved.
 *
 * Keyed by assignmentId, so queuing twice replaces rather than duplicates.
 */
export async function queueSubmission(
  assignmentId: string,
  content: string
): Promise<boolean> {
  try {
    const entry: QueuedSubmission = {
      assignmentId,
      content,
      queuedAt: Date.now(),
      batchId: uuid(),
      error: null,
    };
    await put(STORE.submissionOutbox, entry);
    await requestBackgroundSync();
    return true;
  } catch {
    return false;
  }
}

export async function queuedSubmissions(): Promise<QueuedSubmission[]> {
  try {
    return await getAll<QueuedSubmission>(STORE.submissionOutbox);
  } catch {
    return [];
  }
}

export async function isQueued(assignmentId: string): Promise<boolean> {
  try {
    return Boolean(await get<QueuedSubmission>(STORE.submissionOutbox, assignmentId));
  } catch {
    return false;
  }
}

/** Discard a rejected submission. Only ever called from an explicit tap. */
export async function discardSubmission(assignmentId: string): Promise<void> {
  await del(STORE.submissionOutbox, assignmentId).catch(() => undefined);
}

/**
 * Send everything queued, one at a time and in order.
 *
 * Sequential rather than parallel: a saturated 3G link makes concurrent uploads
 * slower than serial ones, and the shared Spark quota does not want a burst when
 * a whole class reconnects at once. Same rule as the tutor outbox.
 *
 * Outcome rules, matching the tutor queue:
 *   2xx  done, remove, clear the draft
 *   4xx  terminal. Keep the row, record the message, surface it. Never silent.
 *   5xx  transient. Keep it and stop; the next reconnect tries again.
 */
export async function flushSubmissions(): Promise<{ sent: number; kept: number }> {
  if (flushing) return { sent: 0, kept: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { sent: 0, kept: 0 };
  }

  flushing = true;
  try {
    const rows = (await queuedSubmissions()).filter((r) => r.error === null);
    let sent = 0;
    let kept = 0;

    for (const row of rows) {
      try {
        const res = await fetch("/api/student/assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            action: "submit",
            assignmentId: row.assignmentId,
            content: row.content,
            batchId: row.batchId,
          }),
        });

        if (res.ok) {
          await del(STORE.submissionOutbox, row.assignmentId).catch(() => undefined);
          await del(STORE.drafts, row.assignmentId).catch(() => undefined);
          sent++;
          continue;
        }

        if (res.status >= 400 && res.status < 500) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          await put(STORE.submissionOutbox, {
            ...row,
            error: data.error ?? "Your teacher closed this assignment.",
          });
          kept++;
          continue;
        }

        kept++;
        break;
      } catch {
        kept++;
        break;
      }
    }

    return { sent, kept };
  } finally {
    flushing = false;
  }
}

/**
 * Ask for ONE Background Sync when the device next has a network.
 *
 * A one-shot tag, never an interval and never a listener. If the browser has no
 * Background Sync, the flush still happens on the next app open or reconnect.
 */
async function requestBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } })
      .sync;
    await sync?.register(SYNC_TAG);
  } catch {
    // No Background Sync. The reconnect path covers it.
  }
}

/** The draft for one assignment, if the student started writing and stopped. */
export async function getDraft(assignmentId: string): Promise<StoredDraft | null> {
  try {
    return (await get<StoredDraft>(STORE.drafts, assignmentId)) ?? null;
  } catch {
    return null;
  }
}
