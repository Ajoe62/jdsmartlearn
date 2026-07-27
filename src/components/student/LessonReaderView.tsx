"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STORE, get, put } from "@/lib/offline/db";
import type { StoredLesson, StoredMaterial } from "@/lib/offline/db";
import { saveMaterial } from "@/lib/offline/sync";
import { recordView } from "@/lib/offline/outbox";
import { isFileSaved, saveFile } from "@/lib/offline/files";
import { formatBytes } from "@/lib/format";
import type { StudentLessonDetail } from "@/types";

/**
 * One lesson, rendered by BOTH paths:
 *
 *  - online:  the server passes `initial` (already scoped and marking-guide free)
 *  - offline: `initial` is null and this reads IndexedDB by the id in the URL
 *
 * `StudentLessonDetail` has no field a marking guide could occupy, which is the
 * type-level half of the guarantee in CLAUDE.md.
 */
export default function LessonReaderView({
  lessonId,
  initial,
}: {
  lessonId: string;
  initial: StudentLessonDetail | null;
}) {
  const [lesson, setLesson] = useState<StudentLessonDetail | null>(initial);
  const [state, setState] = useState<"ready" | "loading" | "missing">(
    initial ? "ready" : "loading"
  );
  const [online, setOnline] = useState(true);
  /** Whether the ORIGINAL FILE is on this phone - not whether the text is. */
  const [fileSaved, setFileSaved] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  /**
   * Set offline when the lesson HAS an original file that is not on this phone.
   * `lesson.file` is nulled in that case so no dead download link renders, so this
   * is what lets us still explain why the file isn't there.
   */
  const [unsavedFile, setUnsavedFile] = useState<{ name: string; size: number } | null>(
    null
  );
  /** The revision to stamp a saved file with, so a lesson edit invalidates it. */
  const [revision, setRevision] = useState<number | null>(null);

  async function onSaveFile() {
    if (!lesson?.file || revision === null) return;
    setSavingFile(true);
    setFileError(null);
    const result = await saveFile(lessonId, {
      name: lesson.file.name,
      revision,
    });
    setSavingFile(false);
    if (result.ok) {
      setFileSaved(true);
      return;
    }
    setFileError(
      result.reason === "too-large"
        ? "That file is too big to save on your phone."
        : result.reason === "offline"
          ? "You need internet to save this file."
          : result.reason === "unsupported"
            ? "This phone's browser can't save files for offline."
            : "We couldn't save that file. Try again."
    );
  }

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    let alive = true;

    void (async () => {
      // Count the read once per lesson per day, on the device. This replaces a
      // Firestore write on every single page render.
      void recordView(lessonId);

      // Online path: persist what the server gave us so the next read is free,
      // and save the material text alongside it.
      if (initial) {
        try {
          const stored = await get<StoredLesson>(STORE.lessons, lessonId);
          if (stored && initial.studyGuide) {
            await put(STORE.lessons, {
              ...stored,
              studyGuide: initial.studyGuide,
              savedAt: Date.now(),
            });
          }
          if (initial.material) {
            const existing = await get<StoredMaterial>(STORE.materials, lessonId);
            if (!existing) void saveMaterial(lessonId);
          }
          if (stored) {
            if (alive) setRevision(stored.updatedAt);
            if (initial.file) {
              const saved = await isFileSaved(lessonId, stored.updatedAt);
              if (alive) setFileSaved(saved);
            }
          }
        } catch {
          // No device store. Reading still works, it just won't persist.
        }
        return;
      }

      // Offline path: rebuild the lesson from what the device holds.
      try {
        const [stored, material] = await Promise.all([
          get<StoredLesson>(STORE.lessons, lessonId),
          get<StoredMaterial>(STORE.materials, lessonId),
        ]);
        if (!alive) return;

        if (!stored) {
          setState("missing");
          return;
        }

        // The file link must reflect whether the FILE is saved, not whether the
        // text is. Offering a download the service worker cannot serve would give
        // the student a dead tap.
        const haveFile = stored.file ? await isFileSaved(lessonId, stored.updatedAt) : false;
        if (!alive) return;
        setFileSaved(haveFile);
        setRevision(stored.updatedAt);
        setUnsavedFile(stored.file && !haveFile ? stored.file : null);

        setLesson({
          lessonId,
          title: stored.title,
          topicTitle: stored.topicTitle,
          material: material?.text ?? null,
          file: haveFile ? stored.file : null,
          studyGuide: stored.studyGuide,
        });
        setState("ready");
      } catch {
        if (alive) setState("missing");
      }
    })();

    return () => {
      alive = false;
    };
  }, [lessonId, initial]);

  if (state === "loading") {
    return (
      <main className="mx-auto max-w-readable px-5 py-10">
        <p className="text-slate">Opening your lesson…</p>
      </main>
    );
  }

  if (state === "missing" || !lesson) {
    return (
      <main className="mx-auto max-w-readable px-5 py-10">
        <Link href="/student" className="text-sm text-slate">
          &larr; Your subjects
        </Link>
        <div className="mt-6 rounded-lg border border-line bg-chalk p-4">
          <h1 className="font-semibold">This lesson isn&rsquo;t saved on your phone yet</h1>
          <p className="mt-2 text-slate">
            Connect to the internet once to save it. Then you can read it any time.
          </p>
        </div>
      </main>
    );
  }

  const hasNothing = !lesson.material && !lesson.studyGuide;

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/student" className="text-sm text-slate">
        &larr; Your subjects
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{lesson.title}</h1>
      {lesson.topicTitle && lesson.topicTitle !== lesson.title && (
        <p className="mt-1 text-sm text-slate">{lesson.topicTitle}</p>
      )}

      {hasNothing && (
        <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
          The rest of this lesson isn&rsquo;t saved yet. Connect to the internet once to
          save it.
        </p>
      )}

      {lesson.material && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Lesson material</h2>

          {lesson.file && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href={`/api/lessons/${lesson.lessonId}/file`}
                target={lesson.file.inline ? "_blank" : undefined}
                className="inline-flex items-center gap-2 rounded-lg border border-line bg-chalk px-4 py-2 text-sm font-medium text-marker"
              >
                {lesson.file.inline ? "View the original file" : "Download the original file"}
                <span className="font-normal text-slate">
                  ({formatBytes(lesson.file.size)})
                </span>
              </a>

              {fileSaved ? (
                <span className="text-xs text-slate">Saved on your phone</span>
              ) : (
                online && (
                  <button
                    type="button"
                    onClick={() => void onSaveFile()}
                    disabled={savingFile}
                    className="rounded-lg border border-line px-3 py-2 text-sm text-slate disabled:opacity-60"
                  >
                    {savingFile ? "Saving…" : "Save it for offline"}
                  </button>
                )
              )}
            </div>
          )}

          {/*
            Offline, and this lesson's original file was never saved. Say so
            rather than rendering a download link the service worker cannot serve.
          */}
          {unsavedFile && (
            <p className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-xs text-slate">
              The original file ({unsavedFile.name}) isn&rsquo;t saved on your phone.
              You can still read the lesson text below.
            </p>
          )}

          {fileError && <p className="mt-2 text-xs text-flag">{fileError}</p>}

          <article className="mt-3 whitespace-pre-wrap leading-relaxed">
            {lesson.material}
          </article>
        </section>
      )}

      {lesson.studyGuide && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Study guide</h2>
          <article className="mt-3 whitespace-pre-wrap leading-relaxed">
            {lesson.studyGuide.summary}
          </article>

          <h3 className="mt-6 font-semibold">Practice</h3>
          <ol className="mt-3 space-y-3">
            {lesson.studyGuide.questions.map((q) => (
              <li
                key={q.number}
                className="flex gap-3 rounded-lg border border-line bg-chalk p-4"
              >
                <span className="shrink-0 text-slate">{q.number}.</span>
                <span>{q.question}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
