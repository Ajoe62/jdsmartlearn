/**
 * Saved original files (the uploaded PDF or DOCX).
 *
 * Opt-in per lesson, never automatic: a 10 MB PDF is a real cost on a cheap
 * Android, and the extracted text is already the student-facing default on a slow
 * link (CLAUDE.md). The student chooses.
 *
 * The bytes live in the service worker's `jd-files-v1` Cache API bucket - the same
 * bucket the SW serves from, so a saved file works with no network and no extra
 * code path. The `files` IndexedDB store is the index over it: the Cache API
 * records no save time, so LRU eviction would be impossible without it.
 */

import { STORE, del, get, getAll, put, type StoredFile } from "./db";
import { FILE_CAP_BYTES } from "./config";
import { evictionPlan } from "./merge";

const CACHE = "jd-files-v1";

/** The one URL a saved file is ever fetched from - authenticated, class-scoped. */
export function fileUrl(lessonId: string): string {
  return `/api/lessons/${lessonId}/file`;
}

function available(): boolean {
  return typeof caches !== "undefined";
}

/** Is this lesson's original file saved AND still matching the lesson revision? */
export async function isFileSaved(lessonId: string, revision: number): Promise<boolean> {
  try {
    const row = await get<StoredFile>(STORE.files, lessonId);
    if (!row || row.revision !== revision) return false;
    if (!available()) return false;
    // Trust the cache, not just the row - the browser may have evicted the bytes.
    const cache = await caches.open(CACHE);
    return !!(await cache.match(fileUrl(lessonId)));
  } catch {
    return false;
  }
}

export async function savedFiles(): Promise<StoredFile[]> {
  try {
    return await getAll<StoredFile>(STORE.files);
  } catch {
    return [];
  }
}

export type SaveFileResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: "unsupported" | "offline" | "failed" | "too-large" };

/**
 * Download and save one lesson's original file.
 *
 * Goes through the authenticated route like any other request, so class scoping
 * and the material-publish gate still apply - a student cannot save a file they
 * are not allowed to read.
 */
export async function saveFile(
  lessonId: string,
  meta: { name: string; revision: number }
): Promise<SaveFileResult> {
  if (!available()) return { ok: false, reason: "unsupported" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, reason: "offline" };
  }

  try {
    const url = fileUrl(lessonId);
    const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return { ok: false, reason: "failed" };

    // Read once, measure, then store - Content-Length may be absent.
    const blob = await res.blob();
    if (blob.size > FILE_CAP_BYTES) return { ok: false, reason: "too-large" };

    const cache = await caches.open(CACHE);
    await cache.put(
      url,
      new Response(blob, {
        status: 200,
        headers: {
          "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
          "Content-Length": String(blob.size),
          "Content-Disposition":
            res.headers.get("Content-Disposition") ?? "attachment",
        },
      })
    );

    await put(STORE.files, {
      lessonId,
      name: meta.name,
      bytes: blob.size,
      revision: meta.revision,
      savedAt: Date.now(),
    } satisfies StoredFile);

    await trimFiles(lessonId);
    return { ok: true, bytes: blob.size };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Forget one saved file, from both the cache and the index. */
export async function removeFile(lessonId: string): Promise<void> {
  try {
    if (available()) {
      const cache = await caches.open(CACHE);
      await cache.delete(fileUrl(lessonId));
    }
  } catch {
    // Cache gone or denied; still drop the index row below.
  }
  await del(STORE.files, lessonId).catch(() => {});
}

/**
 * Keep the saved-files bucket under its cap, dropping least-recently-saved first.
 * `protect` is the lesson being read right now - evicting that would be perverse.
 */
export async function trimFiles(protect?: string): Promise<string[]> {
  const rows = await savedFiles();
  const drop = evictionPlan(
    rows.map((r) => ({ lessonId: r.lessonId, bytes: r.bytes, savedAt: r.savedAt })),
    FILE_CAP_BYTES,
    protect ? [protect] : []
  );
  for (const id of drop) await removeFile(id);
  return drop;
}

/** Total bytes held, for the "room for files" line in the interface. */
export async function savedFileBytes(): Promise<number> {
  return (await savedFiles()).reduce((n, r) => n + r.bytes, 0);
}
