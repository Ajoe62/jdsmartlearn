/**
 * The student sync state machine.
 *
 *   idle -> index -> guides -> done
 *              \        \
 *               `--------`-- resume from the last committed batch
 *
 * Designed for a link that dies mid-request: progress is committed to IndexedDB
 * after EVERY batch, so a dropped connection costs one batch, never the sync.
 *
 * Triggered on demand only - app open, reconnect, an explicit button, or a
 * one-shot Background Sync tag. Never on an interval (see CLAUDE.md).
 */

import type { SyncIndexEntry } from "@/types";
import {
  STORE,
  delMany,
  getAll,
  getMeta,
  putMany,
  requestPersistence,
  setMeta,
  wipeContent,
  type StoredLesson,
  type StoredMaterial,
} from "./db";
import { batched, evictionPlan, planSync, type LocalLessonState } from "./merge";
import {
  MATERIAL_CAP_BYTES,
  MAX_GUIDE_IDS as GUIDE_BATCH,
  SYNC_STALE_MS,
} from "./config";
import { removeFile } from "./files";

export { SYNC_STALE_MS };

export type SyncPhase = "idle" | "index" | "guides" | "done" | "error" | "offline";

export type SyncProgress = {
  phase: SyncPhase;
  /** Guides downloaded so far this run. */
  done: number;
  /** Guides this run needs in total. */
  total: number;
  lastSyncAt: number | null;
  /** Set when the store was wiped and the student must sign in again. */
  needsSignIn?: boolean;
  message?: string;
};

export type SyncResult = SyncProgress & { changed: boolean };

type Listener = (p: SyncProgress) => void;

const listeners = new Set<Listener>();
let current: SyncProgress = { phase: "idle", done: 0, total: 0, lastSyncAt: null };
let inFlight: Promise<SyncResult> | null = null;

export function onSyncProgress(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

function emit(patch: Partial<SyncProgress>) {
  current = { ...current, ...patch };
  for (const fn of listeners) fn(current);
}

export function syncState(): SyncProgress {
  return current;
}

function graceDays(): number {
  // Mirrored from the server on every sync response so it stays configurable
  // without shipping an env var to the client.
  return graceDaysFromServer ?? 7;
}
let graceDaysFromServer: number | null = null;

/**
 * Enforce the offline grace window. Cached lessons are readable without a live
 * session, so the window is what bounds that; past it the store is wiped and the
 * student must reach the network once more.
 */
export async function enforceGrace(): Promise<{ wiped: boolean }> {
  const meta = await getMeta();
  if (!meta) return { wiped: false };
  if (Date.now() <= meta.offlineGraceUntil) return { wiped: false };
  await wipeContent();
  emit({ phase: "idle", needsSignIn: true, lastSyncAt: null });
  return { wiped: true };
}

/**
 * Drop everything if this device was last used by a different student. A shared
 * phone is the normal case in these schools, so this runs on every boot.
 */
export async function ensureOwner(studentId: string): Promise<void> {
  const meta = await getMeta();
  if (meta && meta.studentId !== studentId) await wipeContent();
}

async function localState(): Promise<LocalLessonState[]> {
  const rows = await getAll<StoredLesson>(STORE.lessons);
  return rows.map((r) => ({
    lessonId: r.lessonId,
    updatedAt: r.updatedAt,
    hasStudyGuide: !!r.studyGuide,
  }));
}

async function trimMaterials(): Promise<void> {
  const rows = await getAll<StoredMaterial>(STORE.materials);
  const drop = evictionPlan(
    rows.map((r) => ({ lessonId: r.lessonId, bytes: r.bytes, savedAt: r.savedAt })),
    MATERIAL_CAP_BYTES
  );
  if (drop.length) await delMany(STORE.materials, drop);
}

/**
 * Run one sync. Concurrent callers share the in-flight run rather than doubling
 * the requests - reconnect and app-open often fire together.
 */
export function sync(opts: { force?: boolean } = {}): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync({ force }: { force?: boolean }): Promise<SyncResult> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    emit({ phase: "offline" });
    return { ...current, changed: false };
  }

  try {
    emit({ phase: "index", done: 0, total: 0, needsSignIn: false, message: undefined });

    const meta = await getMeta();
    const headers: HeadersInit = {};
    if (meta?.etag && !force) headers["If-None-Match"] = meta.etag;

    const res = await fetch("/api/student/sync", {
      headers,
      cache: "no-store",
      credentials: "same-origin",
    });

    // The session lapsed or the student was revoked. Session refresh (and the
    // wipe it may trigger) is handled by ensureSession() before we get here, so
    // this is the belt-and-braces path.
    if (res.status === 401) {
      await wipeContent();
      emit({ phase: "error", needsSignIn: true, message: "Sign in again to read your lessons." });
      return { ...current, changed: false };
    }

    if (res.status === 304 && meta) {
      // Nothing changed on the server. Still extend the grace window - the
      // device just proved it can reach us.
      await setMeta({ ...meta, lastSyncAt: Date.now(), offlineGraceUntil: graceUntil() });
      emit({ phase: "done", lastSyncAt: Date.now() });
      return { ...current, changed: false };
    }

    if (!res.ok) throw new Error(`sync ${res.status}`);

    const body = (await res.json()) as {
      studentId: string;
      classId: string;
      graceDays: number;
      lessons: SyncIndexEntry[];
    };
    graceDaysFromServer = body.graceDays;

    // A class move or a different student invalidates everything held locally.
    if (meta && (meta.studentId !== body.studentId || meta.classId !== body.classId)) {
      await wipeContent();
    }

    const etag = res.headers.get("ETag");
    const plan = planSync(body.lessons, await localState());

    if (plan.remove.length) {
      await delMany(STORE.lessons, plan.remove);
      await delMany(STORE.materials, plan.remove);
      // Unpublished or deleted: the saved original file must go too, or the
      // service worker would keep serving withdrawn content.
      for (const id of plan.remove) await removeFile(id);
    }
    if (plan.staleMaterials.length) {
      await delMany(STORE.materials, plan.staleMaterials);
      // The lesson moved on, so a file saved against the old revision is stale.
      for (const id of plan.staleMaterials) await removeFile(id);
    }

    // Write the index rows first so an interrupted sync still leaves a usable,
    // if guide-less, dashboard.
    const byId = new Map<string, SyncIndexEntry>(body.lessons.map((l) => [l.lessonId, l]));
    const existing = new Map(
      (await getAll<StoredLesson>(STORE.lessons)).map((r) => [r.lessonId, r])
    );
    const now = Date.now();
    await putMany(
      STORE.lessons,
      body.lessons.map((entry): StoredLesson => {
        const prev = existing.get(entry.lessonId);
        const keepGuide =
          entry.hasStudyGuide &&
          prev?.studyGuide &&
          prev.updatedAt === entry.updatedAt
            ? prev.studyGuide
            : null;
        return { ...entry, studyGuide: keepGuide, savedAt: now };
      })
    );

    // ----- guides -----
    emit({ phase: "guides", done: 0, total: plan.fetchGuides.length });

    let fetched = 0;
    for (const chunk of batched(plan.fetchGuides, GUIDE_BATCH)) {
      const r = await fetch(`/api/student/lessons?ids=${chunk.join(",")}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (r.status === 401) {
        await wipeContent();
        emit({ phase: "error", needsSignIn: true, message: "Sign in again to read your lessons." });
        return { ...current, changed: true };
      }
      if (!r.ok) throw new Error(`guides ${r.status}`);

      const guides = (await r.json()) as {
        lessons: { lessonId: string; studyGuide: StoredLesson["studyGuide"] }[];
      };

      // Commit this batch before requesting the next: a drop here loses one
      // batch, not the run.
      await putMany(
        STORE.lessons,
        guides.lessons.flatMap((g) => {
          const entry = byId.get(g.lessonId);
          if (!entry) return [];
          return [{ ...entry, studyGuide: g.studyGuide, savedAt: Date.now() } as StoredLesson];
        })
      );

      fetched += chunk.length;
      emit({ done: fetched });
    }

    await trimMaterials();

    await setMeta({
      studentId: body.studentId,
      classId: body.classId,
      lastSyncAt: Date.now(),
      offlineGraceUntil: graceUntil(),
      etag,
    });

    void requestPersistence();

    emit({ phase: "done", lastSyncAt: Date.now() });
    return { ...current, changed: true };
  } catch (e) {
    // Offline or a flaky link: keep whatever is already saved and say so plainly.
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    emit({
      phase: offline ? "offline" : "error",
      message: offline
        ? undefined
        : e instanceof Error && e.message.startsWith("sync")
          ? "We couldn't update your lessons. Try again."
          : "We couldn't reach the internet. Showing your saved lessons.",
    });
    return { ...current, changed: false };
  }
}

function graceUntil(): number {
  return Date.now() + graceDays() * 24 * 60 * 60 * 1000;
}

/**
 * Fetch and save one lesson's material text. Called when a student opens a
 * lesson online, so re-reading it later needs no network.
 */
export async function saveMaterial(lessonId: string): Promise<StoredMaterial | null> {
  try {
    const r = await fetch(`/api/student/lessons/${lessonId}/material`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { text: string; revision: number };
    const record: StoredMaterial = {
      lessonId,
      text: body.text,
      revision: body.revision,
      savedAt: Date.now(),
      bytes: body.text.length,
    };
    await putMany(STORE.materials, [record]);
    await trimMaterials();
    return record;
  } catch {
    return null;
  }
}

/**
 * Pull every missing material in one go ("Save all for offline").
 * Sequential on purpose: parallel requests on a saturated 3G link make every one
 * of them slower, and progress needs to be honest.
 */
export async function saveAllMaterials(
  onProgress?: (done: number, total: number) => void
): Promise<{ saved: number; failed: number }> {
  const lessons = await getAll<StoredLesson>(STORE.lessons);
  const have = new Set((await getAll<StoredMaterial>(STORE.materials)).map((m) => m.lessonId));
  const todo = lessons.filter((l) => l.hasMaterial && !have.has(l.lessonId));

  let saved = 0;
  let failed = 0;
  for (const [i, l] of todo.entries()) {
    const ok = await saveMaterial(l.lessonId);
    if (ok) saved++;
    else failed++;
    onProgress?.(i + 1, todo.length);
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
  }
  return { saved, failed };
}
