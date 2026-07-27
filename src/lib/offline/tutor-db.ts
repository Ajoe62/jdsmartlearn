/**
 * The tutor device store. Separate database from the student one on purpose.
 *
 * Unlike the student store, this one MAY hold marking guides - they are tutor-only
 * content sitting on the tutor's own phone, which is what the review screen
 * already does in memory. The constraints that make that acceptable:
 *
 *  - namespaced by uid, and wiped when a different tutor signs in;
 *  - wiped on sign-out;
 *  - expires with the 5-day tutor session, so an abandoned phone does not keep
 *    marking guides indefinitely.
 *
 * `assignedClasses` is deliberately NOT stored. It is read fresh from Firestore on
 * every request so a class revocation in ResultPeak applies instantly; caching it
 * here would lengthen that window. A queued op for a revoked class is meant to
 * fail on flush.
 */

import type { QueuedOp } from "./collapse";

export const TUTOR_DB_NAME = "jdsmartlearn-tutor";
export const TUTOR_DB_VERSION = 1;

export const TSTORE = {
  meta: "meta",
  outbox: "outbox",
} as const;

type TutorStore = (typeof TSTORE)[keyof typeof TSTORE];

export type TutorMeta = {
  uid: string;
  /** Matches the tutor session cookie's 5-day life. */
  expiresAt: number;
};

/** Tutor sessions last 5 days; queued work must not outlive its authorization. */
export const TUTOR_STORE_TTL_MS = 5 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(TUTOR_DB_NAME, TUTOR_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TSTORE.meta)) db.createObjectStore(TSTORE.meta);
      if (!db.objectStoreNames.contains(TSTORE.outbox)) {
        db.createObjectStore(TSTORE.outbox, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("tutor db open failed"));
    req.onblocked = () => reject(new Error("tutor db blocked"));
  });

  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run<T>(
  store: TutorStore,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error(`${store} ${mode} failed`));
      })
  );
}

export async function listQueued(): Promise<QueuedOp[]> {
  try {
    const rows = await run<QueuedOp[]>(TSTORE.outbox, "readonly", (s) => s.getAll());
    // Queue order is insertion order, which autoIncrement keys already give us.
    return (rows ?? []).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  } catch {
    return [];
  }
}

export function enqueue(entry: Omit<QueuedOp, "id">): Promise<void> {
  return run<void>(TSTORE.outbox, "readwrite", (s) => s.add(entry)).then(() => undefined);
}

export function updateQueued(entry: QueuedOp): Promise<void> {
  return run<void>(TSTORE.outbox, "readwrite", (s) => s.put(entry)).then(() => undefined);
}

export function dequeue(id: number): Promise<void> {
  return run<void>(TSTORE.outbox, "readwrite", (s) => s.delete(id)).then(() => undefined);
}

export function clearQueue(): Promise<void> {
  return run<void>(TSTORE.outbox, "readwrite", (s) => s.clear()).then(() => undefined);
}

export async function getTutorMeta(): Promise<TutorMeta | undefined> {
  try {
    return await run<TutorMeta | undefined>(TSTORE.meta, "readonly", (s) => s.get("state"));
  } catch {
    return undefined;
  }
}

export function setTutorMeta(meta: TutorMeta): Promise<void> {
  return run<void>(TSTORE.meta, "readwrite", (s) => s.put(meta, "state")).then(
    () => undefined
  );
}

/** Delete the whole tutor database. Sign-out, tutor change, or TTL expiry. */
export function destroyTutorStore(): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  dbPromise = null;
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(TUTOR_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * Drop the store if it belongs to another tutor or has outlived the session.
 * Returns true when it was wiped, so the caller can tell the tutor their queued
 * work is gone rather than letting it vanish silently.
 */
export async function ensureTutorOwner(uid: string): Promise<{ wiped: boolean }> {
  const meta = await getTutorMeta();

  if (meta && (meta.uid !== uid || Date.now() > meta.expiresAt)) {
    const had = (await listQueued()).length > 0;
    await destroyTutorStore();
    await setTutorMeta({ uid, expiresAt: Date.now() + TUTOR_STORE_TTL_MS });
    return { wiped: had };
  }

  await setTutorMeta({ uid, expiresAt: Date.now() + TUTOR_STORE_TTL_MS });
  return { wiped: false };
}
