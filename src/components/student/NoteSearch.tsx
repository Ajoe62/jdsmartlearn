"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { STORE, getAll } from "@/lib/offline/db";
import type { StoredLesson, StoredMaterial } from "@/lib/offline/db";
import {
  matchesQuery,
  snippet,
  toNoteRow,
  topicAnchor,
  weekLabel,
  type NoteRow,
} from "@/lib/notes/group";

/**
 * Search a child's notes and topics.
 *
 * RUNS ON THE PHONE, against what sync already saved there - titles, topics,
 * weeks, study-guide summaries, and the text of every note saved for offline.
 * So it works with no network and costs no Firestore read at all: a search box
 * that queried the server would be a read per keystroke on a quota shared with
 * a live school's exam day.
 *
 * `initial` covers a first visit, before the phone holds anything: titles,
 * topics and weeks only, which is still the search a child most often wants.
 */

export type SearchRow = NoteRow & { subjectId: string; subjectName: string };

type Doc = {
  row: SearchRow;
  /** Everything searchable about the note, joined. */
  text: string;
  /** Section topics with their text, so a hit can jump to the right one. */
  sections: { topicTitle: string; text: string }[];
};

const MAX_RESULTS = 20;

export default function NoteSearch({
  initial,
  subjectId,
  label = "Search your notes",
}: {
  initial: SearchRow[];
  /** Narrow to one subject, on a subject page. */
  subjectId?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Read the phone's copy once, the first time the box opens - not on every
  // page load, which would spend a cheap phone's memory on a box nobody used.
  useEffect(() => {
    if (!open || docs) return;
    input.current?.focus();
    let alive = true;
    void (async () => {
      try {
        const [lessons, bodies] = await Promise.all([
          getAll<StoredLesson>(STORE.lessons),
          getAll<StoredMaterial>(STORE.materials),
        ]);
        if (!alive || lessons.length === 0) return;
        const bodyById = new Map(bodies.map((b) => [b.lessonId, b]));
        setDocs(
          lessons
            .filter((l) => !subjectId || l.subjectId === subjectId)
            .map((l) => {
              const body = bodyById.get(l.lessonId);
              const row = { ...toNoteRow(l), subjectId: l.subjectId, subjectName: l.subjectName };
              const sections = (l.hasSections ? (body?.sections ?? []) : []).map((s) => ({
                topicTitle: s.topicTitle,
                text: `${s.topicTitle} ${s.heading} ${s.body}`,
              }));
              return {
                row,
                sections,
                text: [
                  baseText(row),
                  l.studyGuide?.summary ?? "",
                  body?.text ?? "",
                  ...sections.map((s) => s.text),
                ].join(" \n "),
              };
            })
        );
      } catch {
        // No device store: the titles from the page still search.
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, docs, subjectId]);

  const all: Doc[] = useMemo(
    () =>
      docs ??
      initial
        .filter((r) => !subjectId || r.subjectId === subjectId)
        .map((row) => ({ row, text: baseText(row), sections: [] })),
    [docs, initial, subjectId]
  );

  const q = query.trim();
  const results = useMemo(() => {
    if (q.length < 2) return [];
    return all.filter((d) => matchesQuery(d.text, q)).slice(0, MAX_RESULTS);
  }, [all, q]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-5 flex min-h-[48px] w-full items-center gap-2.5 rounded-xl border border-lineInput bg-surface px-4 text-left text-muted shadow-card transition-colors hover:border-brand"
      >
        <SearchIcon />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div className="mt-5" role="search">
      <div className="flex items-center gap-2 rounded-xl border-2 border-brand bg-surface px-3 shadow-card">
        <SearchIcon />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="A topic, a week, or any word"
          aria-label={label}
          className="min-h-[48px] w-full bg-transparent text-ink outline-none placeholder:text-muted"
        />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setQuery("");
          }}
          className="min-h-[44px] shrink-0 px-2 text-sm font-medium text-accentText"
        >
          Close
        </button>
      </div>

      {q.length >= 2 && (
        <div className="mt-2" aria-live="polite">
          {results.length === 0 ? (
            <p className="rounded-xl bg-canvas px-4 py-3 text-sm text-muted">
              Nothing matches &ldquo;{q}&rdquo;. Try one word, like a topic name or
              &ldquo;week 2&rdquo;.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card">
              {results.map((d) => (
                <li key={d.row.lessonId}>
                  <Link
                    href={hrefFor(d, q)}
                    className="block px-4 py-3 transition-colors hover:bg-canvas"
                  >
                    <p className="text-eyebrow font-semibold uppercase text-brand">
                      {[subjectId ? null : d.row.subjectName, d.row.week !== null || d.row.kind === "weekly" ? weekLabel(d.row.week) : null]
                        .filter(Boolean)
                        .join(" · ") || d.row.topics[0]?.title}
                    </p>
                    <p className="mt-0.5 font-display font-semibold">{d.row.title}</p>
                    {snippetFor(d, q) && (
                      <p className="mt-1 text-sm text-muted">{snippetFor(d, q)}</p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function baseText(row: SearchRow): string {
  return [
    row.title,
    row.subjectName,
    row.week !== null ? `${weekLabel(row.week)} week ${row.week}` : "",
    ...row.topics.map((t) => t.title),
  ].join(" \n ");
}

/** A weekly note opens at the section the search hit, when there is one. */
function hrefFor(d: Doc, q: string): string {
  const base = `/student/lessons/${d.row.lessonId}`;
  const hit = d.sections.find((s) => matchesQuery(s.text, q));
  return hit ? `${base}#${topicAnchor(hit.topicTitle)}` : base;
}

function snippetFor(d: Doc, q: string): string | null {
  const hit = d.sections.find((s) => matchesQuery(s.text, q));
  if (hit) return `${hit.topicTitle}: ${snippet(hit.text, q) ?? ""}`;
  // Titles and topics are already on the card; show only text from inside.
  const deep = d.text.slice(baseText(d.row).length);
  return snippet(deep, q);
}

function SearchIcon() {
  return (
    <svg className="h-5 w-5 shrink-0 text-brand" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m13.2 13.2 3.3 3.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
