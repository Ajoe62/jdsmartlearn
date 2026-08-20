"use client";

import { useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
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
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader title="Your subjects" />

      <NavPills>
        <NavPill href="/student" active>
          Lessons
        </NavPill>
        <NavPill href="/student/assignments">Your work</NavPill>
        <NavPill href="/student/progress">Your progress</NavPill>
      </NavPills>

      {savedAt && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
          <svg className="h-3.5 w-3.5 text-successText" viewBox="0 0 20 20" fill="none" aria-hidden>
            <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="m6.5 10.25 2.25 2.25 4.75-5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Saved on your phone &middot; updated {relativeTime(savedAt)}
        </p>
      )}

      {downloadable > 0 && (
        <Button
          onClick={() => void saveAll()}
          disabled={!!saving}
          className="mt-4 w-full sm:w-auto"
        >
          {saving
            ? `Saving lesson material… ${saving.done} of ${saving.total}`
            : `Save ${downloadable} lesson${downloadable === 1 ? "" : "s"} for offline`}
        </Button>
      )}

      {groups.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No lessons yet">
            Your teacher will publish lessons here soon. Check back after your next class.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          {groups.map((group) => (
            <section key={group.subjectId}>
              <h2 className="text-eyebrow font-semibold uppercase text-muted">
                {group.subjectName}
              </h2>
              <ul className="mt-2.5 space-y-2.5">
                {group.lessons.map((lesson) => (
                  <li key={lesson.lessonId}>
                    <CardLink href={`/student/lessons/${lesson.lessonId}`} className="group">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-display font-semibold">{lesson.title}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {lesson.hasStudyGuide && <Badge tone="info">Study guide</Badge>}
                            {lesson.hasMaterial && <Badge tone="neutral">Material</Badge>}
                          </div>
                        </div>
                        <svg
                          className="h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden
                        >
                          <path
                            d="m6 3.5 4.5 4.5L6 12.5"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    </CardLink>
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
