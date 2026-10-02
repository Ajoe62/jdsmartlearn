"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
import { STORE, getAll } from "@/lib/offline/db";
import type { StoredLesson, StoredMaterial, StoredScheme } from "@/lib/offline/db";
import { onSyncProgress } from "@/lib/offline/sync";
import NoteSearch, { type SearchRow } from "@/components/student/NoteSearch";
import NotesByWeek, { NotesByTopic } from "@/components/student/NotesShelf";
import { toNoteRow, type NoteRow } from "@/lib/notes/group";

/**
 * One subject: its study notes - by week or by topic, with search - its scheme
 * of work, and this child's marks in it.
 *
 * Rendered by BOTH paths, like every other student view - the server passes
 * `initial*` on the first visit and this reads IndexedDB afterwards, so the page
 * works with no network.
 *
 * NOTHING HERE CAN HOLD A MARKING GUIDE. Lessons arrive as the sync projection
 * and schemes as `StudentSchemeSummary`; neither shape has a field for one.
 */

/** A note row. Built with toNoteRow() by both the server page and the device. */
export type SubjectLessonRow = NoteRow;

export interface SubjectSchemeRow {
  schemeId: string;
  title: string;
  term: string | null;
  session: string | null;
}

export interface SubjectMarkRow {
  assignmentId: string;
  title: string;
  percentage: number | null;
  finalScore: number | null;
  maxMarks: number;
  isFinalised: boolean;
  dueDate: number;
}

export default function SubjectDetailView({
  subjectId,
  subjectName,
  initialLessons,
  initialSchemes,
  marks,
}: {
  subjectId: string;
  subjectName: string;
  initialLessons: SubjectLessonRow[];
  initialSchemes: SubjectSchemeRow[];
  /**
   * Marks are NOT re-read from the device here. They come from the server render
   * and stay put: a mark is per-child and already on the assignments page, which
   * owns the offline path for it. Duplicating that read here would be a second
   * place for "is this released yet?" to be decided.
   */
  marks: SubjectMarkRow[];
}) {
  const [lessons, setLessons] = useState(initialLessons);
  const [schemes, setSchemes] = useState(initialSchemes);
  /** Notes whose text is saved on this phone - the mint tick. */
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"week" | "topic">("week");

  // Remember the child's choice of view on this phone. A convenience only: it
  // holds no content, and losing it costs one tap.
  useEffect(() => {
    try {
      if (localStorage.getItem("jd-notes-view") === "topic") setView("topic");
    } catch {
      // Storage blocked. The default view stands.
    }
  }, []);
  function chooseView(v: "week" | "topic") {
    setView(v);
    try {
      localStorage.setItem("jd-notes-view", v);
    } catch {
      // Storage blocked. The choice lasts for this visit.
    }
  }
  /**
   * Resolved from the device when the offline shell renders this page: the URL
   * carries only the subject id, so the shell passes the id as the name and this
   * replaces it with the real one the moment IndexedDB answers.
   */
  const [name, setName] = useState(subjectName);

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const [lessonRows, schemeRows, bodies] = await Promise.all([
          getAll<StoredLesson>(STORE.lessons),
          getAll<StoredScheme>(STORE.schemes),
          getAll<StoredMaterial>(STORE.materials),
        ]);
        if (!alive) return;
        setSaved(new Set(bodies.map((b) => b.lessonId)));

        const mine = lessonRows.filter((l) => l.subjectId === subjectId);
        const denormalized =
          mine[0]?.subjectName ??
          schemeRows.find((s) => s.subjectId === subjectId)?.subjectName;
        if (denormalized) setName(denormalized);

        // Only take over once the device has this subject. Otherwise the server
        // copy stands - a first visit must not blank.
        if (mine.length > 0) setLessons(mine.map(toNoteRow));
        const mySchemes = schemeRows.filter((s) => s.subjectId === subjectId);
        if (mySchemes.length > 0) {
          setSchemes(
            mySchemes.map((s) => ({
              schemeId: s.schemeId,
              title: s.title,
              term: s.term,
              session: s.session,
            }))
          );
        }
      } catch {
        // No device store. The server copy stands.
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
  }, [subjectId]);

  const released = marks.filter((m) => m.isFinalised && m.percentage !== null);

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader eyebrow="Subject" title={name} />

      <NavPills>
        <NavPill href="/student">All subjects</NavPill>
        <NavPill href="/student/assignments">Your work</NavPill>
      </NavPills>

      {schemes.length > 0 && (
        <section className="mt-6" aria-labelledby="scheme-heading">
          <h2 id="scheme-heading" className="text-eyebrow font-semibold uppercase text-muted">
            Scheme of work
          </h2>
          <ul className="mt-2.5 space-y-2.5">
            {schemes.map((s) => (
              <li key={s.schemeId}>
                <CardLink href={`/student/schemes/${encodeURIComponent(s.schemeId)}`}>
                  <p className="font-display font-semibold">{s.title}</p>
                  <p className="mt-1 text-sm text-muted">
                    {termLabel(s)} &middot; What you will cover this term
                  </p>
                </CardLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8" aria-labelledby="lessons-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="lessons-heading" className="text-heading">
            Study notes
          </h2>
          {lessons.length > 0 && (
            <div
              className="inline-flex rounded-full border border-line bg-canvas p-1"
              role="tablist"
              aria-label="Arrange notes"
            >
              <ViewTab active={view === "week"} onClick={() => chooseView("week")}>
                By week
              </ViewTab>
              <ViewTab active={view === "topic"} onClick={() => chooseView("topic")}>
                By topic
              </ViewTab>
            </div>
          )}
        </div>

        {lessons.length > 0 && (
          <NoteSearch
            initial={lessons.map(
              (l): SearchRow => ({ ...l, subjectId, subjectName: name })
            )}
            subjectId={subjectId}
            label={`Search ${name} notes`}
          />
        )}

        {lessons.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No study notes yet">
              Your teacher will publish {name} notes here soon. Check back
              after your next class.
            </EmptyState>
          </div>
        ) : view === "week" ? (
          <NotesByWeek rows={lessons} saved={saved} />
        ) : (
          <NotesByTopic rows={lessons} />
        )}
      </section>

      {marks.length > 0 && (
        <section className="mt-8" aria-labelledby="marks-heading">
          <Card>
            <CardHeader
              title="Your marks"
              hint={
                released.length > 0
                  ? "Only work your teacher has finished marking."
                  : "Nothing has come back yet."
              }
            />
            <ul className="divide-y divide-line">
              {marks.map((m) => (
                <li key={m.assignmentId} className="flex items-center justify-between gap-3 px-4 py-3">
                  <p className="min-w-0 truncate text-sm">{m.title}</p>
                  {m.isFinalised && m.percentage !== null ? (
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {m.finalScore}/{m.maxMarks}{" "}
                      <span className="text-muted">({m.percentage}%)</span>
                    </span>
                  ) : (
                    /* Not a zero. "Not marked yet" and "scored nothing" must
                       never look the same to a child or to a parent. */
                    <span className="shrink-0 text-sm text-muted">Not marked yet</span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </main>
  );
}

/** One half of the By week / By topic switch. */
function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "min-h-[40px] rounded-full px-4 text-sm font-medium transition-colors " +
        (active ? "bg-brand text-white shadow-brand" : "text-muted hover:text-ink")
      }
    >
      {children}
    </button>
  );
}

/**
 * Both strings or neither. "Second Term" alone spans every year the school has
 * run - the exact confusion docs/resultpeak-defects.md defect 1 describes - and
 * a row with no stamp says so plainly rather than being placed in a guess.
 */
function termLabel(row: { term: string | null; session: string | null }): string {
  if (row.term === null || row.session === null) return "Earlier";
  return `${row.term}, ${row.session}`;
}
