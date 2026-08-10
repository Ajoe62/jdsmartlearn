/**
 * What runs when a student opens the app, and what runs when the network comes
 * back. One place, so the ordering is auditable:
 *
 *   1. wipe if a different student last used this phone   (shared-phone safety)
 *   2. wipe if the offline grace window has expired       (bounded offline life)
 *   3. re-authorize against Firestore, wipe if revoked    (revocation on reconnect)
 *   4. sync content, then assignments
 *   5. flush queued read receipts, then queued submissions
 *
 * Steps 1-3 are the security ordering and must stay in that order: never sync
 * into a store that still belongs to someone else.
 *
 * Within step 5 the ORDER matters too. Submissions flush last because a receipt
 * is a soft metric that may be dropped, while a submission is a child's homework
 * and must not be starved by a queue of receipts failing ahead of it.
 */

import { wipeContent } from "./db";
import { ensureOwner, enforceGrace, sync, SYNC_STALE_MS, syncState } from "./sync";
import { flush } from "./outbox";
import { resetAssignmentSync, syncAssignments } from "./assignments-sync";
import { flushSubmissions } from "./submissions";

export type BootResult = {
  /** The student must sign in again - the store was wiped or never existed. */
  needsSignIn: boolean;
  /** Set when the roster says this account is no longer active. */
  revoked: boolean;
};

let booted = false;

/**
 * Re-authorize with the server. Returns false when the device must send the
 * student back to sign-in.
 */
async function ensureSession(): Promise<{ ok: boolean; revoked: boolean }> {
  try {
    const res = await fetch("/api/student/session/refresh", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });

    const body = (await res.json().catch(() => ({}))) as { wipe?: boolean };

    if (!res.ok) {
      // Deactivated or moved away: the saved lessons must not outlive the
      // authorization that produced them.
      if (body.wipe) await wipeContent();
      return { ok: false, revoked: res.status === 401 && !!body.wipe };
    }

    // Moved class - the old class's lessons are no longer hers to read.
    if (body.wipe) await wipeContent();
    return { ok: true, revoked: false };
  } catch {
    // No network. Saved lessons stay readable until the grace window closes.
    return { ok: true, revoked: false };
  }
}

/**
 * Called once per app open by the student layout. `studentId` comes from the
 * server-rendered session, so it is trustworthy.
 */
export async function boot(studentId: string): Promise<BootResult> {
  await ensureOwner(studentId);

  const { wiped } = await enforceGrace();
  if (wiped) {
    // The store this ETag described is gone; keeping it would make the next
    // sync a 304 against an empty device.
    resetAssignmentSync();
    return { needsSignIn: true, revoked: false };
  }

  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  if (online) {
    const { ok, revoked } = await ensureSession();
    if (!ok) {
      resetAssignmentSync();
      return { needsSignIn: true, revoked };
    }
    await sync();
    await syncAssignments();
    void flush().then(() => flushSubmissions());
  }

  booted = true;
  return { needsSignIn: false, revoked: false };
}

/** Re-sync when the tab is shown again, but only if the data has gone stale. */
export async function refreshIfStale(): Promise<void> {
  if (!booted) return;
  const { lastSyncAt } = syncState();
  if (lastSyncAt && Date.now() - lastSyncAt < SYNC_STALE_MS) return;
  await sync();
  await syncAssignments();
  void flush().then(() => flushSubmissions());
}

/**
 * Wire the on-demand triggers. Returns a teardown function.
 *
 * Deliberately NOT an interval and NOT a listener on server state - see the
 * no-polling rule in CLAUDE.md. Every trigger here is an event the student
 * caused or the OS reported.
 */
export function watchConnection(): () => void {
  const onOnline = () => {
    void (async () => {
      const { ok } = await ensureSession();
      if (!ok) return;
      await sync();
      await syncAssignments();
      void flush().then(() => flushSubmissions());
    })();
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") void refreshIfStale();
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  // One-shot Background Sync where the browser supports it (Chrome on Android,
  // which is the target). Not Periodic Background Sync - that needs an installed
  // PWA and engagement heuristics, and would amount to polling.
  void registerBackgroundSync();

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

async function registerBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sync = (reg as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    })?.sync;
    await sync?.register("jd-outbox");
    // A separate tag so a child's queued homework is not lost behind a batch of
    // read receipts failing, and so the worker can tell the two apart.
    await sync?.register("jd-submissions");
  } catch {
    // Unsupported or denied. The online/visibility triggers cover it.
  }
}
