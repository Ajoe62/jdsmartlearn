/**
 * Minimal IndexedDB wrapper for the student device store.
 *
 * Hand-rolled rather than pulling in `idb`: we need get/put/delete/getAll/clear
 * and nothing else, and this repo keeps its dependency list deliberately short.
 *
 * NOTHING in here may hold a marking guide. The stores are fed from the sync
 * routes, which serve the safe projection built by toStudentPayload (see
 * CLAUDE.md, Offline rules).
 */

export const DB_NAME = "jdsmartlearn";
/**
 * v2 added the `files` store (saved original files).
 * v3 added `assignments`, `submissions` and `drafts` for assessment.
 */
export const DB_VERSION = 3;

export const STORE = {
  meta: "meta",
  lessons: "lessons",
  materials: "materials",
  files: "files",
  outbox: "outbox",
  /** The assignment list, keyed by assignmentId. Never holds a marking guide. */
  assignments: "assignments",
  /** This student's own submissions, keyed by assignmentId. */
  submissions: "submissions",
  /** Answers still being written, keyed by assignmentId. */
  drafts: "drafts",
  /**
   * Finished answers waiting for a network. Separate from `outbox`, which holds
   * read receipts: a receipt is a soft metric that may be dropped, a submission
   * is a child's work that may not.
   */
  submissionOutbox: "submissionOutbox",
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

/** What the device knows about its own sync state. Single row, key "state". */
export type OfflineMeta = {
  studentId: string;
  classId: string;
  lastSyncAt: number;
  /** After this, cached lessons are wiped and re-sign-in is required. */
  offlineGraceUntil: number;
  /** ETag of the last index response, so an unchanged sync costs one 304. */
  etag: string | null;
};

export type StoredLesson = {
  lessonId: string;
  title: string;
  topicTitle: string;
  subjectId: string;
  subjectName: string;
  hasMaterial: boolean;
  hasStudyGuide: boolean;
  updatedAt: number;
  studyGuide: { summary: string; questions: { number: number; question: string }[] } | null;
  file: { name: string; size: number; inline: boolean } | null;
  savedAt: number;
};

export type StoredMaterial = {
  lessonId: string;
  text: string;
  revision: number;
  savedAt: number;
  bytes: number;
};

/**
 * Bookkeeping for an original file the student chose to save. The bytes live in
 * the service worker's Cache API bucket; this row is what makes them findable and
 * evictable, since the Cache API records no save time of its own.
 */
export type StoredFile = {
  lessonId: string;
  name: string;
  bytes: number;
  /** The lesson's updatedAt when saved - a change means the file is stale. */
  revision: number;
  savedAt: number;
};

/**
 * One row of the assignment list, saved for offline reading.
 *
 * Mirrors AssignmentListItem minus the fields the device recomputes (isOverdue
 * depends on the current time, so storing it would go stale in the drawer).
 * Carries no marking guide, because the projection it comes from has no field
 * for one.
 */
export type StoredAssignment = {
  assignmentId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  type: string;
  dueDate: number;
  maxMarks: number;
  /** Instructions, saved when the student opens the assignment. */
  description: string | null;
  allowedFileTypes: string[];
  savedAt: number;
};

/**
 * This student's own submission for one assignment.
 *
 * A finalised submission never changes again, so it is kept until the grace
 * window wipes the store. An unfinalised one is refreshed on every sync.
 */
export type StoredSubmission = {
  assignmentId: string;
  status: string;
  submittedAt: number;
  content: string;
  maxMarks: number;
  finalScore: number | null;
  feedback: string | null;
  strengths: string[] | null;
  improvements: string[] | null;
  topicsToRevise: { topic: string; lessonId: string | null }[] | null;
  topicsMastered: string[] | null;
  teacherComment: string | null;
  savedAt: number;
};

/** An answer still being written. Survives a closed tab and a dead battery. */
export type StoredDraft = {
  assignmentId: string;
  content: string;
  updatedAt: number;
};

/**
 * A finished answer waiting for a network.
 *
 * Text only, always. A multi-megabyte photo held here until reconnect would blow
 * the device budget and put an unmanaged copy of a child's work outside the
 * grace window and the wipe-on-sign-in path, so a submission with attachments
 * requires a connection and the form says so before they start.
 */
export type QueuedSubmission = {
  assignmentId: string;
  content: string;
  queuedAt: number;
  /** Stable across retries, so a replayed flush cannot double-post. */
  batchId: string;
  /** Set when the server rejected it for good. Surfaced, never silently dropped. */
  error: string | null;
};

export type OutboxView = {
  id?: number;
  kind: "view";
  lessonId: string;
  /** UTC day, so a student re-reading tomorrow counts again. */
  dayKey: string;
  count: number;
  /** Stable across retries - the server dedupes on it. */
  batchId: string;
  state: "pending" | "sending";
  createdAt: number;
};

function supported(): boolean {
  return typeof indexedDB !== "undefined";
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!supported()) return Promise.reject(new Error("IndexedDB unavailable"));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.meta)) db.createObjectStore(STORE.meta);
      if (!db.objectStoreNames.contains(STORE.lessons)) {
        db.createObjectStore(STORE.lessons, { keyPath: "lessonId" });
      }
      if (!db.objectStoreNames.contains(STORE.materials)) {
        db.createObjectStore(STORE.materials, { keyPath: "lessonId" });
      }
      if (!db.objectStoreNames.contains(STORE.files)) {
        db.createObjectStore(STORE.files, { keyPath: "lessonId" });
      }
      if (!db.objectStoreNames.contains(STORE.outbox)) {
        db.createObjectStore(STORE.outbox, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE.assignments)) {
        db.createObjectStore(STORE.assignments, { keyPath: "assignmentId" });
      }
      if (!db.objectStoreNames.contains(STORE.submissions)) {
        db.createObjectStore(STORE.submissions, { keyPath: "assignmentId" });
      }
      if (!db.objectStoreNames.contains(STORE.drafts)) {
        db.createObjectStore(STORE.drafts, { keyPath: "assignmentId" });
      }
      if (!db.objectStoreNames.contains(STORE.submissionOutbox)) {
        // Keyed by assignmentId, so queuing the same assignment twice replaces
        // rather than duplicates. One submission per assignment, on the device
        // as well as on the server.
        db.createObjectStore(STORE.submissionOutbox, { keyPath: "assignmentId" });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // A version change from another tab invalidates this handle.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked by another tab"));
  });

  // Don't cache a rejected promise - a later attempt should retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

function run<T>(
  store: StoreName,
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

export function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run<T | undefined>(store, "readonly", (s) => s.get(key));
}

export function getAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, "readonly", (s) => s.getAll()).then((r) => r ?? []);
}

export function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  return run<void>(store, "readwrite", (s) =>
    key === undefined ? s.put(value) : s.put(value, key)
  ).then(() => undefined);
}

export function del(store: StoreName, key: IDBValidKey): Promise<void> {
  return run<void>(store, "readwrite", (s) => s.delete(key)).then(() => undefined);
}

export function clear(store: StoreName): Promise<void> {
  return run<void>(store, "readwrite", (s) => s.clear()).then(() => undefined);
}

/** Write many records in one transaction - one commit per sync batch. */
export function putMany(store: StoreName, values: unknown[]): Promise<void> {
  if (values.length === 0) return Promise.resolve();
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const s = tx.objectStore(store);
        for (const v of values) s.put(v);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error(`${store} bulk put failed`));
        tx.onabort = () => reject(tx.error ?? new Error(`${store} bulk put aborted`));
      })
  );
}

export function delMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const s = tx.objectStore(store);
        for (const k of keys) s.delete(k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error(`${store} bulk delete failed`));
      })
  );
}

// ---------- meta ----------

const META_KEY = "state";

export function getMeta(): Promise<OfflineMeta | undefined> {
  return get<OfflineMeta>(STORE.meta, META_KEY).catch(() => undefined);
}

export function setMeta(meta: OfflineMeta): Promise<void> {
  return put(STORE.meta, meta, META_KEY);
}

// ---------- lifecycle ----------

/**
 * Wipe every trace of the current student's content.
 *
 * Called when: a DIFFERENT student signs in on this device (a shared phone is
 * the normal case, not the edge case), the offline grace window expires, or the
 * server reports the student was deactivated or moved class.
 */
export async function wipeContent(): Promise<void> {
  await Promise.all([
    clear(STORE.lessons).catch(() => {}),
    clear(STORE.materials).catch(() => {}),
    clear(STORE.files).catch(() => {}),
    clear(STORE.outbox).catch(() => {}),
    clear(STORE.meta).catch(() => {}),
  ]);
}

/**
 * Delete the whole database. Harder than wipeContent and used on sign-out, so
 * nothing survives a schema change or a partially-written store.
 */
export function destroy(): Promise<void> {
  if (!supported()) return Promise.resolve();
  dbPromise = null;
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    // Resolve either way - failing to delete must not block signing out.
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * Ask the browser not to evict us under storage pressure. Best effort - Chrome
 * grants it based on engagement, and a refusal is not an error.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return null;
  }
}

export const isSupported = supported;
