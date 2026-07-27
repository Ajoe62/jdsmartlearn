/**
 * Pure sync-diff logic. No IndexedDB, no fetch, no DOM - so it can be reasoned
 * about and tested directly.
 *
 * This is the file where a bug shows a student content a tutor has withdrawn.
 * The rule it enforces: the server index is the ONLY authority on what exists.
 * Anything the index does not list is deleted locally, without exception.
 */

import type { SyncIndexEntry } from "@/types";

export type LocalLessonState = {
  lessonId: string;
  updatedAt: number;
  /** Whether the device already holds the study-guide body. */
  hasStudyGuide: boolean;
};

export type SyncPlan = {
  /** Lessons whose study-guide body must be downloaded. */
  fetchGuides: string[];
  /** Lessons to remove from the device: unpublished, deleted, or moved away. */
  remove: string[];
  /** Materials to drop because the lesson changed under them. */
  staleMaterials: string[];
};

/**
 * Work out what a device must do to match the server index.
 *
 * A guide is fetched when the device has no copy, when `updatedAt` moved (an
 * edit, a republish), or when the lesson newly gained a guide. `updatedAt` is
 * the whole staleness signal - it is bumped by every lesson mutation
 * (updateLessonDetails, setStudentPayload, setMaterialPublished, publish).
 */
export function planSync(
  index: SyncIndexEntry[],
  local: LocalLessonState[]
): SyncPlan {
  const localById = new Map(local.map((l) => [l.lessonId, l]));
  const remoteIds = new Set<string>();

  const fetchGuides: string[] = [];
  const staleMaterials: string[] = [];

  for (const entry of index) {
    remoteIds.add(entry.lessonId);
    const mine = localById.get(entry.lessonId);

    const changed = !mine || mine.updatedAt !== entry.updatedAt;

    // Material text is cached separately and keyed to the lesson revision, so a
    // changed lesson invalidates it even if the material itself was untouched.
    if (changed && mine) staleMaterials.push(entry.lessonId);

    if (entry.hasStudyGuide && (changed || !mine.hasStudyGuide)) {
      fetchGuides.push(entry.lessonId);
    }
  }

  // Anything the server no longer lists is gone: unpublished, deleted, or the
  // student was moved to another class. Removing is the safe default.
  const remove = local
    .map((l) => l.lessonId)
    .filter((id) => !remoteIds.has(id));

  return { fetchGuides, remove, staleMaterials };
}

/** Split ids into fixed-size request batches so each response stays small on 3G. */
export function batched<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("batch size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Merge a server index entry over whatever the device holds.
 *
 * The guide is carried forward only when the server still says the lesson has
 * one AND the device is not being told to re-fetch it. When in doubt this drops
 * the guide rather than keeping a possibly-withdrawn copy.
 */
export function mergeEntry<
  G extends { summary: string; questions: { number: number; question: string }[] },
>(
  entry: SyncIndexEntry,
  existingGuide: G | null,
  incomingGuide: G | null
): Omit<SyncIndexEntry, never> & { studyGuide: G | null } {
  const guide = entry.hasStudyGuide ? (incomingGuide ?? existingGuide) : null;
  return { ...entry, studyGuide: guide };
}

/**
 * Least-recently-saved eviction. Returns the ids to drop so the total falls back
 * under `capBytes`, oldest first. A cheap Android has little room to spare and
 * saved lessons must never be the reason the phone runs out.
 */
export function evictionPlan(
  items: { lessonId: string; bytes: number; savedAt: number }[],
  capBytes: number,
  protectedIds: string[] = []
): string[] {
  const total = items.reduce((n, i) => n + i.bytes, 0);
  if (total <= capBytes) return [];

  const keep = new Set(protectedIds);
  const candidates = items
    .filter((i) => !keep.has(i.lessonId))
    .sort((a, b) => a.savedAt - b.savedAt);

  const drop: string[] = [];
  let freed = 0;
  for (const c of candidates) {
    if (total - freed <= capBytes) break;
    drop.push(c.lessonId);
    freed += c.bytes;
  }
  return drop;
}

/** UTC day key, matching the server's dayKey() so view counting agrees. */
export function dayKey(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------- shared view shaping ----------

export type DashboardLesson = {
  lessonId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  hasMaterial: boolean;
  hasStudyGuide: boolean;
};

export type DashboardGroup = {
  subjectId: string;
  subjectName: string;
  lessons: DashboardLesson[];
};

/**
 * Group lessons by subject for the dashboard.
 *
 * Lives here, in pure code, because BOTH renderers use it: the server page after
 * getClassSyncIndex, and the offline shell after reading IndexedDB. One
 * implementation means the two paths cannot drift apart.
 *
 * Input order is preserved within a subject (the index arrives newest-first).
 */
export function groupBySubject(lessons: DashboardLesson[]): DashboardGroup[] {
  const groups = new Map<string, DashboardGroup>();
  for (const l of lessons) {
    let g = groups.get(l.subjectId);
    if (!g) {
      g = { subjectId: l.subjectId, subjectName: l.subjectName, lessons: [] };
      groups.set(l.subjectId, g);
    }
    g.lessons.push(l);
  }
  return [...groups.values()].sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}
