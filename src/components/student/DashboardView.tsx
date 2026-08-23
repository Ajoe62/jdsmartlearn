"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
import { STORE, getAll, getMeta } from "@/lib/offline/db";
import type { StoredMaterial } from "@/lib/offline/db";
import { onSyncProgress, saveAllMaterials } from "@/lib/offline/sync";

/**
 * The student dashboard shell, rendered by BOTH paths:
 *
 *  - online first visit: the server passes the shelf and the announcements in
 *  - offline / repeat:    the SW serves this page and each slot reads IndexedDB
 *
 * WHAT THIS COMPONENT NOW OWNS is only the chrome: the title, the tabs, the
 * "saved on your phone" line and the save-for-offline button. The subject shelf
 * and the announcements are passed in as slots and read their own data.
 *
 * It used to own the lesson list too, grouped by subject. That list moved to
 * `/student/subjects/[subjectId]`, because a child taking nine subjects had to
 * scroll past every lesson in all of them to reach the one they wanted, and
 * because a flat list has nowhere to put a mark, a scheme of work, or a term.
 */
export default function DashboardView({
  announcements,
  shelf,
}: {
  announcements?: React.ReactNode;
  shelf?: React.ReactNode;
}) {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [downloadable, setDownloadable] = useState(0);
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const [lessons, materials, meta] = await Promise.all([
          getAll<{ lessonId: string; hasMaterial: boolean }>(STORE.lessons),
          getAll<StoredMaterial>(STORE.materials),
          getMeta(),
        ]);
        if (!alive) return;
        const have = new Set(materials.map((m) => m.lessonId));
        setSavedAt(meta?.lastSyncAt ?? null);
        setDownloadable(lessons.filter((l) => l.hasMaterial && !have.has(l.lessonId)).length);
      } catch {
        // No device store (private mode, old browser). The page still works.
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

  async function saveAll() {
    setSaving({ done: 0, total: downloadable });
    await saveAllMaterials((done, total) => setSaving({ done, total }));
    setSaving(null);
    const materials = await getAll<StoredMaterial>(STORE.materials).catch(() => []);
    const lessons = await getAll<{ lessonId: string; hasMaterial: boolean }>(
      STORE.lessons
    ).catch(() => []);
    const have = new Set(materials.map((m) => m.lessonId));
    setDownloadable(lessons.filter((l) => l.hasMaterial && !have.has(l.lessonId)).length);
  }

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader title="Your subjects" />

      <NavPills>
        <NavPill href="/student" active>
          Subjects
        </NavPill>
        <NavPill href="/student/assignments">Your work</NavPill>
        <NavPill href="/student/progress">Your progress</NavPill>
      </NavPills>

      {/* Above everything else on purpose. A notice that the school closes early
          today is worth more than a subject list, and it is the one thing on this
          screen a child did not come looking for. */}
      {announcements}

      {shelf}

      {savedAt && (
        <p className="mt-8 flex items-center gap-1.5 text-xs text-muted">
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
          variant="secondary"
          className="mt-3 w-full sm:w-auto"
        >
          {saving
            ? `Saving lesson material… ${saving.done} of ${saving.total}`
            : `Save ${downloadable} lesson${downloadable === 1 ? "" : "s"} for offline`}
        </Button>
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
