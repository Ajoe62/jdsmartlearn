"use client";

import { useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import { Card, CardHeader, CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
import { STORE, getAll } from "@/lib/offline/db";
import type { StoredLesson, StoredScheme } from "@/lib/offline/db";
import { onSyncProgress } from "@/lib/offline/sync";

/**
 * One subject: its lessons, its scheme of work, and this child's marks in it.
 *
 * Rendered by BOTH paths, like every other student view - the server passes
 * `initial*` on the first visit and this reads IndexedDB afterwards, so the page
 * works with no network.
 *
 * NOTHING HERE CAN HOLD A MARKING GUIDE. Lessons arrive as the sync projection
 * and schemes as `StudentSchemeSummary`; neither shape has a field for one.
 */

export interface SubjectLessonRow {
  lessonId: string;
  title: string;
  hasMaterial: boolean;
  hasStudyGuide: boolean;
  term: string | null;
  session: string | null;
}

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
        const [lessonRows, schemeRows] = await Promise.all([
          getAll<StoredLesson>(STORE.lessons),
          getAll<StoredScheme>(STORE.schemes),
        ]);
        if (!alive) return;

        const mine = lessonRows.filter((l) => l.subjectId === subjectId);
        const denormalized =
          mine[0]?.subjectName ??
          schemeRows.find((s) => s.subjectId === subjectId)?.subjectName;
        if (denormalized) setName(denormalized);

        // Only take over once the device has this subject. Otherwise the server
        // copy stands - a first visit must not blank.
        if (mine.length > 0) {
          setLessons(
            mine.map((l) => ({
              lessonId: l.lessonId,
              title: l.title,
              hasMaterial: l.hasMaterial,
              hasStudyGuide: l.hasStudyGuide,
              term: l.term ?? null,
              session: l.session ?? null,
            }))
          );
        }
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
        <h2 id="lessons-heading" className="text-eyebrow font-semibold uppercase text-muted">
          Lessons
        </h2>
        {lessons.length === 0 ? (
          <div className="mt-2.5">
            <EmptyState title="No lessons yet">
              Your teacher will publish {name} lessons here soon. Check back
              after your next class.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-2.5 space-y-2.5">
            {lessons.map((l) => (
              <li key={l.lessonId}>
                <CardLink href={`/student/lessons/${l.lessonId}`} className="group">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-display font-semibold">{l.title}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {l.hasStudyGuide && <Badge tone="info">Study guide</Badge>}
                        {l.hasMaterial && <Badge tone="neutral">Material</Badge>}
                        <span className="text-xs text-muted">{termLabel(l)}</span>
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

/**
 * Both strings or neither. "Second Term" alone spans every year the school has
 * run - the exact confusion docs/resultpeak-defects.md defect 1 describes - and
 * a row with no stamp says so plainly rather than being placed in a guess.
 */
function termLabel(row: { term: string | null; session: string | null }): string {
  if (row.term === null || row.session === null) return "Earlier";
  return `${row.term}, ${row.session}`;
}
