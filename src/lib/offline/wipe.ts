/**
 * Remove every trace of a student from this device.
 *
 * Shared phones are the normal case in these schools, so this runs on sign-out
 * AND before a different student's first sync. It clears both stores that can
 * hold lesson content: IndexedDB and the service worker's caches.
 */

import { destroy } from "./db";

export async function wipeDevice(): Promise<void> {
  await Promise.all([destroy(), purgeCaches()]);
}

/**
 * Ask the service worker to drop its caches, and clear them directly too - the
 * worker may not be controlling this page yet, and sign-out must not depend on it.
 */
async function purgeCaches(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "PURGE" });
  } catch {
    // No worker. The direct pass below still runs.
  }

  try {
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("jd-")).map((k) => caches.delete(k)));
  } catch {
    // Storage denied. Nothing more we can do from here.
  }
}
