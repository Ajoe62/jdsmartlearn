import Link from "next/link";
import { termOrder } from "@/lib/academic-calendar";
import {
  groupByTopic,
  groupByWeek,
  weekLabel,
  type NoteRow,
  type TermGroup,
} from "@/lib/notes/group";

/**
 * A subject's study notes, arranged two ways: By week and By topic.
 *
 * No state and no effects - the weeks fold with <details>, which costs no
 * JavaScript and works before the page has finished loading on a slow link.
 * The grouping is lib/notes/group, shared with the offline path.
 *
 * Colour follows docs/ilumo-brand.md: indigo carries the week numbers (the
 * thing a child scans for), azure the topic labels, and mint appears only on
 * "Saved" - the completed state, and the only place it is spent.
 */

export default function NotesByWeek({
  rows,
  saved,
}: {
  rows: NoteRow[];
  /** Notes whose text is saved on this phone. */
  saved: Set<string>;
}) {
  const terms = groupByWeek(rows, termOrder);
  const openKey = currentWeekKey(terms);

  return (
    <div className="mt-5 space-y-7">
      {terms.map((t) => (
        <section key={`${t.term}\t${t.session}`} aria-label={termLabel(t)}>
          <p className="text-eyebrow font-semibold uppercase text-muted">{termLabel(t)}</p>
          <div className="mt-2.5 space-y-3">
            {t.weeks.map((w) => {
              const key = `${t.term}\t${t.session}\t${w.week}`;
              const topics = distinctTopics(w.notes);
              return (
                <details
                  key={key}
                  open={key === openKey}
                  className="group overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
                >
                  <summary className="flex min-h-[64px] cursor-pointer list-none items-center gap-3.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
                    <span
                      aria-hidden
                      className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-brandSoft text-brand"
                    >
                      <span className="text-[0.625rem] font-semibold uppercase leading-none tracking-wider">
                        Week
                      </span>
                      <span className="tabular font-display text-xl font-semibold leading-tight">
                        {w.week ?? "–"}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-subheading font-semibold">
                        {weekLabel(w.week)}
                      </span>
                      <span className="block truncate text-sm text-muted">
                        {w.notes.length} note{w.notes.length === 1 ? "" : "s"}
                        {topics.length > 0 && <> &middot; {topics.join(", ")}</>}
                      </span>
                    </span>
                    <Chevron />
                  </summary>
                  <ul className="divide-y divide-line border-t border-line">
                    {w.notes.map((n) => (
                      <li key={n.lessonId}>
                        <NoteLink note={n} saved={saved.has(n.lessonId)} />
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** One card per topic: every note on it, weekly notes opening at their section. */
export function NotesByTopic({ rows }: { rows: NoteRow[] }) {
  const topics = groupByTopic(rows);
  if (topics.length === 0) {
    return (
      <p className="mt-5 rounded-2xl bg-canvas px-4 py-4 text-sm text-muted">
        Topics show here once your teacher publishes the study guide for these
        notes. Until then, find them under By week.
      </p>
    );
  }
  return (
    <ul className="mt-5 grid gap-3 sm:grid-cols-2">
      {topics.map((t) => (
        <li
          key={t.title}
          className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
        >
          <div className="border-l-4 border-l-accent bg-accentSoft px-4 py-3">
            <p className="font-display text-subheading font-semibold">{t.title}</p>
            <p className="text-sm text-muted">
              {t.entries.length} note{t.entries.length === 1 ? "" : "s"}
            </p>
          </div>
          <ul className="divide-y divide-line">
            {t.entries.map((e) => (
              <li key={e.lessonId}>
                <Link
                  href={`/student/lessons/${e.lessonId}${e.anchor ? `#${e.anchor}` : ""}`}
                  className="flex min-h-[52px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-canvas"
                >
                  <span className="w-16 shrink-0 text-xs font-semibold uppercase text-brand">
                    {e.week !== null ? `Week ${e.week}` : e.kind === "weekly" ? "Weekly" : "Topic"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.title}</span>
                  <Chevron right />
                </Link>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function NoteLink({ note, saved }: { note: NoteRow; saved: boolean }) {
  return (
    <Link
      href={`/student/lessons/${note.lessonId}`}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-canvas"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{note.title}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {note.kind === "weekly" && (
            <span className="rounded-full bg-brandSoft px-2 py-0.5 text-xs font-medium text-brand">
              Weekly notes
            </span>
          )}
          {note.topics.slice(0, 3).map((t) => (
            <span
              key={t.title}
              className="rounded-full bg-accentSoft px-2 py-0.5 text-xs font-medium text-accentText"
            >
              {t.title}
            </span>
          ))}
          {note.hasStudyGuide && <span className="text-xs text-muted">Study guide</span>}
          {saved && (
            <span className="inline-flex items-center gap-1 text-xs text-successText">
              <span
                aria-hidden
                className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success"
              >
                <svg className="h-2.5 w-2.5 text-ink" viewBox="0 0 10 10" fill="none">
                  <path d="m2.2 5.2 1.8 1.8 3.8-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              Saved
            </span>
          )}
        </span>
      </span>
      <Chevron right />
    </Link>
  );
}

function Chevron({ right }: { right?: boolean }) {
  return (
    <svg
      className={
        "h-4 w-4 shrink-0 text-muted transition-transform " +
        (right ? "" : "rotate-90 group-open:-rotate-90")
      }
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Which week opens by itself: the latest numbered week of the newest term,
 * which is nearly always the week the child is in. Everything else stays folded
 * so a child who wants Week One sees Week One.
 */
function currentWeekKey(terms: TermGroup[]): string | null {
  const t = terms[0];
  if (!t) return null;
  const numbered = t.weeks.filter((w) => w.week !== null);
  const w = numbered[numbered.length - 1] ?? t.weeks[0];
  return `${t.term}\t${t.session}\t${w.week}`;
}

function distinctTopics(notes: NoteRow[]): string[] {
  const out: string[] = [];
  for (const n of notes) {
    for (const t of n.topics) {
      if (!out.some((x) => x.toLowerCase() === t.title.toLowerCase())) out.push(t.title);
    }
  }
  return out.slice(0, 4);
}

/** Both strings or neither - see the same rule on the subject page. */
function termLabel(t: { term: string | null; session: string | null }): string {
  if (t.term === null || t.session === null) return "Earlier";
  return `${t.term}, ${t.session}`;
}
