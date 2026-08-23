/**
 * Announcements on the device.
 *
 * Three jobs, and only three:
 *
 *   save()     write what a sync returned into IndexedDB
 *   dismiss()  apply a dismissal locally, then try to send it
 *   flushReads() send whatever dismissals are still queued
 *
 * There is NO fetch of announcements here. They arrive inside the existing sync
 * response (see /api/student/sync), because a fetch of their own would be
 * something to poll and polling is forbidden - CLAUDE.md, Quota rules.
 */

import {
  STORE,
  clear,
  del,
  getAll,
  getMeta,
  put,
  putMany,
  setMeta,
  type QueuedNoticeRead,
  type StoredAnnouncement,
} from "./db";
import {
  EMPTY_READ_STATE,
  isUnread,
  type NoticeItem,
  type ReadState,
} from "@/lib/announcements/notices";

/**
 * How long an unsent dismissal is worth keeping.
 *
 * A week. Past that the notice has almost certainly expired anyway, and a
 * dismissal is the lowest-stakes write in the product: the cost of losing one is
 * that a child taps "Got it" a second time.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** At most one request per flush. The whole queue fits in one body. */
const MAX_PER_FLUSH = 50;

let flushing = false;

/**
 * Replace the device's announcement set with what the server just sent.
 *
 * REPLACE, not merge. A notice the server no longer lists has been withdrawn or
 * has expired, and the reason a school withdraws a notice is that it was wrong -
 * so it must leave the phone on the next sync rather than linger until a wipe.
 */
export async function saveAnnouncements(
  items: NoticeItem[],
  readState: ReadState
): Promise<void> {
  try {
    const now = Date.now();
    await clear(STORE.announcements);
    await putMany(
      STORE.announcements,
      items.map((n): StoredAnnouncement => ({ ...n, savedAt: now }))
    );

    const meta = await getMeta();
    // No meta yet means the lesson sync has not committed one this run; it will
    // write the read state itself from the same response. Nothing to do here.
    if (meta) await setMeta({ ...meta, readState });
  } catch {
    // No device store (private mode, an old browser). The server-rendered copy
    // still shows; only offline reading is lost.
  }
}

export async function getAnnouncements(): Promise<StoredAnnouncement[]> {
  try {
    return await getAll<StoredAnnouncement>(STORE.announcements);
  } catch {
    return [];
  }
}

export async function getReadState(): Promise<ReadState> {
  try {
    return (await getMeta())?.readState ?? EMPTY_READ_STATE;
  } catch {
    return EMPTY_READ_STATE;
  }
}

/**
 * Count what the badge shows, from the device alone.
 *
 * Calls the SAME function the server does. `isUnread` takes `NoticeRef`, which a
 * stored row satisfies, so the badge on the phone and the badge rendered on the
 * server cannot disagree about what "unread" means.
 */
export function countUnread(
  items: StoredAnnouncement[],
  state: ReadState
): number {
  return items.reduce((total, n) => total + (isUnread(n, state) ? 1 : 0), 0);
}

/**
 * A student tapped "Got it".
 *
 * Applies the dismissal to the local mirror FIRST so the card goes away
 * immediately on a dead link, queues it, then tries to send. The returned state
 * is what the caller should render with.
 */
export async function dismiss(id: string): Promise<ReadState> {
  const current = await getReadState();
  const optimistic: ReadState = current.readIds.includes(id)
    ? current
    : { seenAt: current.seenAt, readIds: [...current.readIds, id] };

  try {
    const meta = await getMeta();
    if (meta) await setMeta({ ...meta, readState: optimistic });
    const row: QueuedNoticeRead = { id, queuedAt: Date.now() };
    await put(STORE.noticeReads, row);
  } catch {
    // No store. The send below may still work; if it does not, the card comes
    // back on the next render, which is the honest outcome.
  }

  const sent = await flushReads();
  return sent ?? optimistic;
}

/**
 * Send every queued dismissal. Safe to call often - no-ops when already running,
 * when offline, or when the queue is empty.
 *
 * Returns the server's read state when it sent something, so the caller can
 * replace its optimistic copy with the compacted one; null otherwise.
 */
export async function flushReads(): Promise<ReadState | null> {
  if (flushing) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;

  flushing = true;
  try {
    let rows: QueuedNoticeRead[];
    try {
      rows = await getAll<QueuedNoticeRead>(STORE.noticeReads);
    } catch {
      return null;
    }

    const cutoff = Date.now() - MAX_AGE_MS;
    const stale = rows.filter((r) => r.queuedAt < cutoff);
    for (const r of stale) await del(STORE.noticeReads, r.id).catch(() => {});

    const live = rows.filter((r) => r.queuedAt >= cutoff).slice(0, MAX_PER_FLUSH);
    if (live.length === 0) return null;

    const res = await fetch("/api/student/announcements/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ids: live.map((r) => r.id) }),
    });

    /**
     * A 4xx is terminal and a 5xx is retried, the same rule the submission
     * outbox follows - except that here a terminal failure is DROPPED SILENTLY
     * rather than surfaced. That is deliberate and is the one place this queue
     * differs: a dismissal is not a child's work, and interrupting a student to
     * report that a "Got it" tap did not save would be worse than the notice
     * reappearing once.
     */
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        for (const r of live) await del(STORE.noticeReads, r.id).catch(() => {});
      }
      return null;
    }

    for (const r of live) await del(STORE.noticeReads, r.id).catch(() => {});

    const state = (await res.json().catch(() => null)) as ReadState | null;
    if (state && typeof state.seenAt === "number" && Array.isArray(state.readIds)) {
      const meta = await getMeta().catch(() => undefined);
      if (meta) await setMeta({ ...meta, readState: state }).catch(() => {});
      return state;
    }
    return null;
  } catch {
    // Offline or a flaky link. The queue keeps them for the next reconnect.
    return null;
  } finally {
    flushing = false;
  }
}
