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
import { toNoteRow, topicAnchor, weekLabel } from "@/lib/notes/group";
import type { NoteSection, StudentLessonDetail } from "@/types";

/**
 * One lesson, rendered by BOTH paths:
 *
 *  - online:  the server passes `initial` (already scoped and marking-guide free)
 *  - offline: `initial` is null and this reads IndexedDB by the id in the URL
 *
 * `StudentLessonDetail` has no field a marking guide could occupy, which is the
 * type-level half of the guarantee in CLAUDE.md.
 *
 * `material` is null when the material is NOT PUBLISHED, and "" when it is
 * published but has no text - a lesson whose original is a scan, slides or a
 * photo. Every test below is against null, never falsiness, or that lesson
 * would render as empty.
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
          // Saved even when empty: "published, but it's a file" must survive
          // going offline as itself, not as "not saved yet". A weekly note's
          // topic sections are saved in the same row.
          if (initial.material !== null || initial.sections) {
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

        const row = toNoteRow(stored);
        setLesson({
          lessonId,
          title: stored.title,
          topicTitle: stored.topicTitle,
          kind: row.kind,
          week: row.week,
          topics: row.topics,
          // Only while the guide is still published - sections go with it.
          sections: stored.hasSections ? (material?.sections ?? null) : null,
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

  /**
   * "By topic" links straight to a section (`#t-fractions`). The browser only
   * jumps on its own when the section is in the first HTML, which the offline
   * path never is - so jump once the lesson has rendered.
   */
  useEffect(() => {
    if (state !== "ready" || !window.location.hash) return;
    const el = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    el?.scrollIntoView();
  }, [state]);

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

  const hasNothing = lesson.material === null && !lesson.studyGuide && !lesson.sections;
  const sections = lesson.sections;
  const showTopics =
    lesson.topics.length > 0 &&
    (lesson.kind === "weekly" || lesson.topics.some((t) => t.title !== lesson.title));

  return (
    <main className="mx-auto max-w-readable px-5 py-8">
      <BackToSubjects />

      {(lesson.week !== null || lesson.kind === "weekly") && (
        <p className="mt-4 text-eyebrow font-semibold uppercase text-brand">
          {weekLabel(lesson.week)}
          {lesson.kind === "weekly" && " study notes"}
        </p>
      )}
      <h1 className={lesson.week !== null || lesson.kind === "weekly" ? "mt-1 text-title" : "mt-4 text-title"}>
        {lesson.title}
      </h1>
      {showTopics && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Topics in this note">
          {lesson.topics.map((t) => (
            <li key={t.title}>
              {sections ? (
                <a
                  href={`#${topicAnchor(t.title)}`}
                  className="inline-flex min-h-[32px] items-center rounded-full bg-accentSoft px-3 text-xs font-medium text-accentText hover:underline"
                >
                  {t.title}
                </a>
              ) : (
                <span className="inline-flex min-h-[32px] items-center rounded-full bg-accentSoft px-3 text-xs font-medium text-accentText">
                  {t.title}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {sections && <TopicSections sections={sections} />}

      {hasNothing && (
        <Callout tone="neutral" className="mt-6" title="The rest of this lesson isn't saved yet">
          Connect to the internet once to save it.
        </Callout>
      )}

      {lesson.material !== null && (
        <section className="mt-8">
          <h2 className="text-heading">{sections ? "The whole note" : "Lesson material"}</h2>

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
              {lesson.material
                ? " You can still read the lesson text below."
                : " Connect to the internet to open it."}
            </Callout>
          )}

          {fileError && (
            <Callout tone="danger" className="mt-3">
              {fileError}
            </Callout>
          )}

          {lesson.material ? (
            sections ? (
              /* The same words as the sections above, in the teacher's order.
                 Folded away so a child reading by topic does not scroll past it
                 twice. */
              <details className="mt-3 rounded-xl border border-line bg-surface p-4">
                <summary className="min-h-[44px] cursor-pointer py-2.5 text-sm font-medium text-accentText">
                  Read it as your teacher wrote it
                </summary>
                <article className="prose-lesson mt-2 whitespace-pre-wrap">{lesson.material}</article>
              </details>
            ) : (
              <article className="prose-lesson mt-4 whitespace-pre-wrap">{lesson.material}</article>
            )
          ) : (
            lesson.file && (
              <p className="mt-4 text-muted">
                Your teacher shared this lesson as a file. Open it with the button above.
              </p>
            )
          )}
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

/**
 * A weekly note, by topic. Each section has an anchor so "By topic" on the
 * subject page lands on it. The words are the teacher's own - the AI only chose
 * which paragraphs go under which topic, and the teacher approved it.
 */
function TopicSections({ sections }: { sections: NoteSection[] }) {
  const seen = new Set<string>();
  return (
    <section className="mt-8" aria-labelledby="by-topic-heading">
      <h2 id="by-topic-heading" className="text-heading">
        Notes by topic
      </h2>
      <div className="mt-4 space-y-4">
        {sections.map((s, i) => {
          // The first section on a topic carries its anchor; a second one on the
          // same topic follows it without stealing the jump.
          const anchor = topicAnchor(s.topicTitle);
          const id = seen.has(anchor) ? undefined : anchor;
          seen.add(anchor);
          return (
            <article
              key={i}
              id={id}
              className="scroll-mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card"
            >
              <header className="border-l-4 border-l-brand bg-brandSoft px-4 py-3">
                <p className="text-eyebrow font-semibold uppercase text-brand">{s.topicTitle}</p>
                {s.heading !== s.topicTitle && (
                  <h3 className="mt-0.5 font-display text-subheading font-semibold">{s.heading}</h3>
                )}
              </header>
              <div className="prose-lesson whitespace-pre-wrap px-4 py-4">{s.body}</div>
            </article>
          );
        })}
      </div>
    </section>
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
