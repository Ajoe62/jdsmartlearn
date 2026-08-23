"use client";

import { useEffect, useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import Callout from "@/components/ui/Callout";
import { CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import StatTile, { StatRow } from "@/components/ui/StatTile";
import { cn } from "@/lib/cn";
import { termOrder } from "@/lib/academic-calendar";
import {
  ALL_TERMS,
  buildShelf,
  shelfTotals,
  termOptions,
  type ShelfSubject,
  type ShelfTotals,
  type TermFilter,
  type TermOption,
} from "@/lib/shelf/build";
import { readShelfInputs, type ShelfInputs } from "@/lib/offline/shelf";
import { onSyncProgress } from "@/lib/offline/sync";

/**
 * The subject shelf, rendered by BOTH paths:
 *
 *  - online first visit: the server passes `initial`, already filtered
 *  - offline / repeat:    this reads IndexedDB and runs the SAME buildShelf()
 *
 * That shared function is the point. A shelf computed one way on the server and
 * another way on the device would eventually disagree about a child's marks, and
 * nobody would notice which one was wrong. `buildShelf` is pure and has twelve
 * tests; both callers hand it the same shape.
 *
 * THE TERM SWITCHER DOES NOT NAVIGATE when the device has data. It re-runs the
 * filter locally, so switching terms works with no network at all - which is the
 * whole reason the term and session are stamped onto each row rather than
 * resolved at read time.
 */
export default function SubjectShelfView({
  initial,
  initialTotals,
  initialTerms,
  subjectsIncomplete,
  hasUndated,
}: {
  initial: ShelfSubject[];
  initialTotals: ShelfTotals;
  initialTerms: TermOption[];
  subjectsIncomplete: boolean;
  hasUndated: boolean;
}) {
  const [filter, setFilter] = useState<TermFilter>(ALL_TERMS);
  const [device, setDevice] = useState<ShelfInputs | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const inputs = await readShelfInputs();
      // Only take over once the device actually has lessons. A first visit
      // renders from the server copy and must not blank on an empty store.
      if (alive && inputs && inputs.lessons.length > 0) setDevice(inputs);
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

  const { subjects, totals, terms } = useMemo(() => {
    if (!device) {
      // The server already applied `filter` = all. Re-filtering a projection we
      // cannot recompute would produce wrong counts, so the switcher is inert
      // until the device store arrives - which is one sync away.
      return { subjects: initial, totals: initialTotals, terms: initialTerms };
    }
    const built = buildShelf({ ...device, filter, now: Date.now() });
    return {
      subjects: built,
      totals: shelfTotals(built),
      terms: termOptions(
        [...device.lessons, ...device.assignments, ...device.schemes],
        termOrder
      ),
    };
  }, [device, filter, initial, initialTotals, initialTerms]);

  const canSwitch = device !== null && terms.length > 1;
  const undated = device
    ? [...device.lessons, ...device.assignments, ...device.schemes].some(
        (r) => r.term === null || r.session === null
      )
    : hasUndated;

  return (
    <section className="mt-6" aria-labelledby="shelf-heading">
      <h2 id="shelf-heading" className="sr-only">
        Your subjects
      </h2>

      <StatRow>
        <StatTile
          value={totals.overdue > 0 ? totals.overdue : totals.due}
          label={totals.overdue > 0 ? "late" : "to do"}
          tone={totals.overdue > 0 ? "attention" : "neutral"}
          href="/student/assignments"
        />
        <StatTile
          value={totals.marked}
          label="marked"
          tone={totals.marked > 0 ? "good" : "neutral"}
          href="/student/assignments?tab=graded"
        />
        <StatTile value={totals.lessons} label="lessons" />
      </StatRow>

      {canSwitch && (
        <TermSwitcher terms={terms} filter={filter} onChange={setFilter} />
      )}

      {subjectsIncomplete && (
        <Callout tone="info" className="mt-4">
          Your school is still setting up. You may not see every subject you take
          yet — ask your teacher if one is missing.
        </Callout>
      )}

      {subjects.length === 0 ? (
        <div className="mt-5">
          <EmptyState title="No subjects yet">
            Your subjects will appear here once your teachers start adding lessons.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {subjects.map((s) => (
            <li key={s.subjectId}>
              <SubjectCard subject={s} />
            </li>
          ))}
        </ul>
      )}

      {undated && filter.kind !== "all" && (
        <p className="mt-4 text-xs text-muted">
          Some older work is not filed under a term yet, so it only shows under
          &ldquo;All time&rdquo;.
        </p>
      )}
    </section>
  );
}

function SubjectCard({ subject: s }: { subject: ShelfSubject }) {
  return (
    <CardLink href={`/student/subjects/${encodeURIComponent(s.subjectId)}`} className="group h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display font-semibold">{s.subjectName}</p>

          {s.isEmpty ? (
            <p className="mt-1.5 text-sm text-muted">Nothing added yet</p>
          ) : (
            <p className="mt-1.5 text-sm text-muted">
              {countLine([
                [s.lessonCount, "lesson"],
                [s.schemeCount, "scheme of work"],
                [s.markedCount, "marked"],
              ])}
            </p>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {s.overdueCount > 0 && (
              <Badge tone="danger">
                {s.overdueCount} late
              </Badge>
            )}
            {s.dueCount > 0 && <Badge tone="solid">{s.dueCount} to do</Badge>}
            {s.studyGuideCount > 0 && (
              <Badge tone="info">{s.studyGuideCount} study guide{s.studyGuideCount === 1 ? "" : "s"}</Badge>
            )}
          </div>
        </div>

        {/* The average, only when something has actually been released. Null is
            "nothing back yet" and must not render as a zero, which is a mark. */}
        {s.averagePercent !== null && (
          <div className="shrink-0 text-right">
            <p
              className={cn(
                "font-display text-xl font-semibold tabular-nums",
                s.averagePercent >= 50 ? "text-successText" : "text-warn"
              )}
            >
              {s.averagePercent}%
            </p>
            <p className="text-xs text-muted">average</p>
          </div>
        )}
      </div>
    </CardLink>
  );
}

/**
 * Plain English rather than a row of icons. "3 lessons · 1 marked" is readable
 * by a Primary 4 pupil; a row of glyphs with counts is not.
 */
function countLine(parts: [number, string][]): string {
  const said = parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 || word.endsWith("work") ? "" : "s"}`);
  return said.length > 0 ? said.join(" · ") : "Nothing added yet";
}

function TermSwitcher({
  terms,
  filter,
  onChange,
}: {
  terms: TermOption[];
  filter: TermFilter;
  onChange: (f: TermFilter) => void;
}) {
  const isAll = filter.kind === "all";
  return (
    <div className="mt-4 -mx-5 overflow-x-auto px-5">
      <div
        className="flex w-max gap-2"
        role="group"
        aria-label="Show work from"
      >
        <TermChip active={isAll} onClick={() => onChange(ALL_TERMS)}>
          All time
        </TermChip>
        {terms.map((t) => (
          <TermChip
            key={`${t.session}\t${t.term}`}
            active={!isAll && filter.term === t.term && filter.session === t.session}
            onClick={() => onChange({ kind: "pair", term: t.term, session: t.session })}
          >
            {/* Both strings, always. "Second Term" alone spans every year the
                school has run, and two sessions of it is the exact confusion
                docs/resultpeak-defects.md defect 1 is about. */}
            {t.term} <span className="opacity-70">{t.session}</span>
          </TermChip>
        ))}
      </div>
    </div>
  );
}

function TermChip({
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
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // 44px like every other target: tapped on a phone held one-handed.
        "inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors",
        active
          ? "bg-brand text-white"
          : "border border-line bg-surface text-ink hover:border-lineStrong hover:bg-canvas"
      )}
    >
      {children}
    </button>
  );
}
