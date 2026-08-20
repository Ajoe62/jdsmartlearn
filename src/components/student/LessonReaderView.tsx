"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, ButtonAnchor } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
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
        <p className="text-muted">Opening your lesson…</p>
      </main>
    );
  }

  if (state === "missing" || !lesson) {
    return (
      <main className="mx-auto max-w-readable px-5 py-8">
        <BackToSubjects />
        <div className="mt-6">
          <EmptyState title="This lesson isn't saved on your phone yet">
            Connect to the internet once to save it. Then you can read it any time.
          </EmptyState>
        </div>
      </main>
    );
  }

  const hasNothing = !lesson.material && !lesson.studyGuide;

  return (
    <main className="mx-auto max-w-readable px-5 py-8">
      <BackToSubjects />
      <h1 className="mt-4 text-title">{lesson.title}</h1>
      {lesson.topicTitle && lesson.topicTitle !== lesson.title && (
        <p className="mt-1.5 text-muted">{lesson.topicTitle}</p>
      )}

      {hasNothing && (
        <Callout tone="neutral" className="mt-6" title="The rest of this lesson isn't saved yet">
          Connect to the internet once to save it.
        </Callout>
      )}

      {lesson.material && (
        <section className="mt-8">
          <h2 className="text-heading">Lesson material</h2>

          {lesson.file && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ButtonAnchor
                href={`/api/lessons/${lesson.lessonId}/file`}
                target={lesson.file.inline ? "_blank" : undefined}
              >
                {lesson.file.inline ? "View the original file" : "Download the original file"}
                <span className="font-normal text-muted">
                  ({formatBytes(lesson.file.size)})
                </span>
              </ButtonAnchor>

              {fileSaved ? (
                <span className="text-xs text-muted">Saved on your phone</span>
              ) : (
                online && (
                  <Button variant="ghost" onClick={() => void onSaveFile()} disabled={savingFile}>
                    {savingFile ? "Saving…" : "Save it for offline"}
                  </Button>
                )
              )}
            </div>
          )}

          {/*
            Offline, and this lesson's original file was never saved. Say so
            rather than rendering a download link the service worker cannot serve.
          */}
          {unsavedFile && (
            <Callout tone="neutral" className="mt-3">
              The original file ({unsavedFile.name}) isn&rsquo;t saved on your phone.
              You can still read the lesson text below.
            </Callout>
          )}

          {fileError && (
            <Callout tone="danger" className="mt-3">
              {fileError}
            </Callout>
          )}

          <article className="prose-lesson mt-4 whitespace-pre-wrap">{lesson.material}</article>
        </section>
      )}

      {lesson.studyGuide && (
        <section className="mt-10">
          <h2 className="text-heading">Study guide</h2>
          <article className="prose-lesson mt-4 whitespace-pre-wrap">
            {lesson.studyGuide.summary}
          </article>

          <h3 className="mt-8 text-subheading font-semibold">Practice</h3>
          <ol className="mt-3 space-y-2.5">
            {lesson.studyGuide.questions.map((q) => (
              <Card as="li" key={q.number} className="flex gap-3 p-4">
                <span
                  aria-hidden
                  className="tabular flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brandSoft text-sm font-semibold text-brand"
                >
                  {q.number}
                </span>
                <span className="pt-0.5">{q.question}</span>
              </Card>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

/** The only way back on a student's phone, so it is a target, not a footnote. */
function BackToSubjects() {
  return (
    <Link
      href="/student"
      className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-accentText"
    >
      <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M10 3.5 5.5 8l4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Your subjects
    </Link>
  );
}
