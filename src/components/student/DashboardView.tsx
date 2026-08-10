"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STORE, getAll, getMeta } from "@/lib/offline/db";
import type { StoredLesson, StoredMaterial } from "@/lib/offline/db";
import { groupBySubject, type DashboardLesson } from "@/lib/offline/merge";
import { onSyncProgress, saveAllMaterials } from "@/lib/offline/sync";

/**
 * The student dashboard, rendered by BOTH paths:
 *
 *  - online first visit: the server passes `initial` from the cached class bundle
 *  - offline / repeat:    `initial` is null and this reads IndexedDB
 *
 * One component, so the two paths cannot drift. Nothing here can hold a marking
 * guide - the shape has no field for one.
 */
export default function DashboardView({
  initial,
}: {
  initial: DashboardLesson[] | null;
}) {
  const [lessons, setLessons] = useState<DashboardLesson[] | null>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);

  // Re-read the device store after every sync, and on mount when the server gave
  // us nothing (the offline shell).
  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const [rows, materials, meta] = await Promise.all([
          getAll<StoredLesson>(STORE.lessons),
          getAll<StoredMaterial>(STORE.materials),
          getMeta(),
        ]);
        if (!alive) return;
        setSavedIds(new Set(materials.map((m) => m.lessonId)));
        setSavedAt(meta?.lastSyncAt ?? null);
        // Only replace server-rendered content once the device actually has some.
        if (rows.length > 0) {
          setLessons(
            rows.map((r) => ({
              lessonId: r.lessonId,
              title: r.title,
              subjectId: r.subjectId,
              subjectName: r.subjectName,
              hasMaterial: r.hasMaterial,
              hasStudyGuide: r.hasStudyGuide,
            }))
          );
        }
      } catch {
        // No device store (private mode, old browser). The server copy stands.
      }
    };

    void load();
    const stop = onSyncProgress((p) => {
      if (p.phase === "done") void load();
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const groups = groupBySubject(lessons ?? []);
  const downloadable = (lessons ?? []).filter(
    (l) => l.hasMaterial && !savedIds.has(l.lessonId)
  ).length;

  async function saveAll() {
    setSaving({ done: 0, total: downloadable });
    await saveAllMaterials((done, total) => setSaving({ done, total }));
    setSaving(null);
    const materials = await getAll<StoredMaterial>(STORE.materials).catch(() => []);
    setSavedIds(new Set(materials.map((m) => m.lessonId)));
  }

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <h1 className="text-2xl font-semibold">Your subjects</h1>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        <Link href="/student/assignments" className="text-sm text-marker underline">
          Your work
        </Link>
        <Link href="/student/progress" className="text-sm text-marker underline">
          Your progress
        </Link>
      </div>

      {savedAt && (
        <p className="mt-2 text-xs text-slate">
          Saved on your phone &middot; updated {relativeTime(savedAt)}
        </p>
      )}

      {downloadable > 0 && (
        <button
          type="button"
          onClick={() => void saveAll()}
          disabled={!!saving}
          className="mt-4 w-full rounded-lg border border-line bg-chalk px-4 py-3 text-sm font-medium text-marker disabled:opacity-60 sm:w-auto"
        >
          {saving
            ? `Saving lesson material… ${saving.done} of ${saving.total}`
            : `Save ${downloadable} lesson${downloadable === 1 ? "" : "s"} for offline`}
        </button>
      )}

      {groups.length === 0 ? (
        <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
          No lessons yet. Your teacher will publish lessons here soon.
        </p>
      ) : (
        <div className="mt-6 space-y-8">
          {groups.map((group) => (
            <section key={group.subjectId}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">
                {group.subjectName}
              </h2>
              <ul className="mt-2 space-y-2">
                {group.lessons.map((lesson) => (
                  <li key={lesson.lessonId}>
                    <Link
                      href={`/student/lessons/${lesson.lessonId}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-chalk p-4 hover:border-marker"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{lesson.title}</p>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs">
                          {lesson.hasMaterial && (
                            <span className="rounded-full bg-paper px-2 py-0.5 text-slate">
                              Material
                            </span>
                          )}
                          {lesson.hasStudyGuide && (
                            <span className="rounded-full bg-markerSoft px-2 py-0.5 text-marker">
                              Study guide
                            </span>
                          )}
                        </div>
                      </div>
                      <span aria-hidden className="text-slate">
                        &rsaquo;
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

/** Plain words, not a timestamp - "2 hours ago" is what a student needs. */
function relativeTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
