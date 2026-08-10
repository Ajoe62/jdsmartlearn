/**
 * Pull the student's assignments onto the device.
 *
 * Runs inside the existing lifecycle in boot.ts, AFTER the three security steps
 * that own the store. It never runs on its own schedule: app open, reconnect, or
 * a stale-tab refresh. No interval, no listener, no onSnapshot.
 *
 * Small on purpose. The whole payload for a class of assignments is a few
 * kilobytes, so unlike lessons there is no index-then-bodies split and no
 * per-item opt-in to save. One request, one transaction.
 *
 * A marking guide cannot arrive here. The sync route projects through
 * toStudentAssignment() and toStudentSubmissionPayload(), and the stored shapes
 * have no field one could occupy.
 */

import { STORE, delMany, getAll, putMany } from "./db";
import type { StoredAssignment, StoredSubmission } from "./db";

interface SyncPayload {
  assignments: Omit<StoredAssignment, "savedAt">[];
  submissions: Omit<StoredSubmission, "savedAt">[];
}

let etag: string | null = null;

export async function syncAssignments(): Promise<{ changed: boolean }> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { changed: false };
  }

  let payload: SyncPayload;
  try {
    const res = await fetch("/api/student/assignments/sync", {
      credentials: "same-origin",
      headers: etag ? { "If-None-Match": etag } : undefined,
    });

    // Nothing set and nothing marked since the last sync. The common case.
    if (res.status === 304) return { changed: false };
    if (!res.ok) return { changed: false };

    etag = res.headers.get("etag");
    payload = (await res.json()) as SyncPayload;
  } catch {
    // No network mid-request. What is already saved stays readable.
    return { changed: false };
  }

  const savedAt = Date.now();

  try {
    /**
     * Remove what the server no longer lists BEFORE writing.
     *
     * A tutor switching an assignment off must take it off the phone too, the
     * same rule the lesson sync follows for a withdrawn lesson. Without this,
     * a child keeps working on something their teacher closed.
     */
    const [storedAssignments, storedSubmissions] = await Promise.all([
      getAll<StoredAssignment>(STORE.assignments),
      getAll<StoredSubmission>(STORE.submissions),
    ]);

    const live = new Set(payload.assignments.map((a) => a.assignmentId));
    await delMany(
      STORE.assignments,
      storedAssignments.filter((a) => !live.has(a.assignmentId)).map((a) => a.assignmentId)
    );
    await delMany(
      STORE.submissions,
      storedSubmissions.filter((s) => !live.has(s.assignmentId)).map((s) => s.assignmentId)
    );

    await putMany(
      STORE.assignments,
      payload.assignments.map((a) => ({ ...a, savedAt }))
    );
    await putMany(
      STORE.submissions,
      payload.submissions.map((s) => ({ ...s, savedAt }))
    );

    return { changed: true };
  } catch {
    // No device store (private mode, old browser). The server-rendered pages
    // still work; only offline reading is unavailable.
    return { changed: false };
  }
}

/** Drop the cached ETag so the next sync fetches a full body. Used after a wipe. */
export function resetAssignmentSync(): void {
  etag = null;
}
