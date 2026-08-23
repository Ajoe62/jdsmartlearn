// The subject shelf. NO "server-only" here and nothing imported at all,
// deliberately: this decides which term a child's work is filed under, and a
// term filter that silently drops a lesson is the exact failure the term/session
// rules in CLAUDE.md exist to prevent. Same treatment as
// src/lib/announcements/notices.ts, and covered by the same module-boundary
// guard in scripts/test-offline.ts.
//
// It holds no secret and reads no environment. It also runs on the DEVICE, over
// the same rows IndexedDB holds, so the offline shelf and the server-rendered
// shelf are the same function rather than two that agree today.

// ---------------------------------------------------------------------------
// The term filter
// ---------------------------------------------------------------------------

/**
 * A term and session pair, or every one of them.
 *
 * `{ term, session }` are ResultPeak's strings, compared with `===` and NEVER
 * normalised, trimmed or case folded. That is not fussiness: ResultPeak joins a
 * result sheet on the literal strings, so a value this code tidied is a value
 * that silently stops joining. See src/lib/academic-calendar.ts.
 */
export type TermFilter = { kind: "all" } | { kind: "pair"; term: string; session: string };

export const ALL_TERMS: TermFilter = { kind: "all" };

/** A term/session pair observed in a student's own work, with how much is in it. */
export interface TermOption {
  term: string;
  session: string;
  /** Lessons plus assignments carrying this pair. Drives the "(12)" in a picker. */
  count: number;
}

/**
 * Rows carrying a term and session. Structural so a `SyncLesson`, a
 * `StoredLesson` and an assignment list item all satisfy it without conversion.
 *
 * BOTH ARE NULLABLE, and the pair is only usable when BOTH are present. A lesson
 * with a term and no session cannot be placed: "Second Term" alone spans every
 * year the school has ever run, and ResultPeak's own session default is wrong
 * for two thirds of the calendar (docs/resultpeak-defects.md, defect 1).
 */
export interface Dated {
  term: string | null;
  session: string | null;
}

/**
 * Does this row belong in the current filter?
 *
 * A row with no pair matches ONLY the "all" filter. It is never swept into the
 * current term to make the screen look fuller - that would tell a child a lesson
 * was taught this term when nobody knows when it was taught.
 */
export function matchesTerm(row: Dated, filter: TermFilter): boolean {
  if (filter.kind === "all") return true;
  if (row.term === null || row.session === null) return false;
  return row.term === filter.term && row.session === filter.session;
}

/** True when a row predates the term stamp and can only be shown under "Earlier". */
export function isUndated(row: Dated): boolean {
  return row.term === null || row.session === null;
}

/**
 * The pairs to offer in the switcher, newest session first.
 *
 * BUILT FROM THE STUDENT'S OWN ROWS, never constructed. There is no list of
 * terms to enumerate against: `RESULTPEAK_TERMS` names the three strings but
 * nothing names the sessions, which are free text in ResultPeak. Offering a pair
 * the child has no work in would be a filter that always shows an empty screen.
 *
 * Ordering is session descending, then term position within a session. `order`
 * is passed in rather than imported so this module stays free of every import -
 * callers pass `termOrder` from lib/academic-calendar.
 */
export function termOptions(
  rows: Dated[],
  order: (term: string) => number
): TermOption[] {
  const counts = new Map<string, TermOption>();

  for (const row of rows) {
    if (isUndated(row)) continue;
    // A tab character cannot appear in either string, so this key cannot
    // collide the way `${term}-${session}` could across an odd pair.
    const key = `${row.term}\t${row.session}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { term: row.term!, session: row.session!, count: 1 });
  }

  return [...counts.values()].sort((a, b) => {
    if (a.session !== b.session) return b.session.localeCompare(a.session);
    return order(a.term) - order(b.term);
  });
}

// ---------------------------------------------------------------------------
// The shelf
// ---------------------------------------------------------------------------

/** One lesson, as much of it as the shelf needs. */
export interface ShelfLesson extends Dated {
  lessonId: string;
  subjectId: string;
  hasMaterial: boolean;
  hasStudyGuide: boolean;
}

/** One assignment set for this class. */
export interface ShelfAssignment extends Dated {
  assignmentId: string;
  subjectId: string;
  dueDate: number;
}

/**
 * This student's own submission. `finalScorePercent` is null at every status
 * except `finalised` - the projection upstream returns null for an unreleased
 * score, and this module must never infer one from a status it has not been
 * shown.
 */
export interface ShelfSubmission {
  assignmentId: string;
  subjectId: string;
  isFinalised: boolean;
  finalScorePercent: number | null;
}

/** A scheme of work published for this class. */
export interface ShelfScheme extends Dated {
  schemeId: string;
  subjectId: string;
}

export interface ShelfSubject {
  subjectId: string;
  subjectName: string;
  lessonCount: number;
  studyGuideCount: number;
  schemeCount: number;
  /** Set but not yet submitted, and not yet past the due date. */
  dueCount: number;
  /** Submitted and past the due date with nothing sent. Shown loudly. */
  overdueCount: number;
  markedCount: number;
  /**
   * The mean of this subject's finalised percentages inside the current filter,
   * rounded, or null when nothing has been released yet.
   *
   * AN AVERAGE WITHIN ONE FILTER ONLY. Never across terms: the annual figure is
   * ResultPeak's arithmetic and nothing in this codebase may compute one
   * (CLAUDE.md, Assessment rules). Under the "all" filter this is a lifetime
   * mean of JDSmartLearn coursework, which is not an annual average and is not
   * offered as one - it is labelled "all time" wherever it renders.
   */
  averagePercent: number | null;
  /** Nothing published yet, but the class is allocated this subject. */
  isEmpty: boolean;
}

/**
 * Build the shelf.
 *
 * `subjects` is the class's offering - the union of tutor allocations with
 * whatever actually has content, resolved upstream in db/class-subjects.ts. It
 * drives the row set, so a subject with an allocated tutor and no lesson yet
 * still appears (as `isEmpty`) rather than vanishing from a child's list.
 *
 * Everything else is filtered by `filter` before it is counted.
 */
export function buildShelf(input: {
  subjects: { id: string; name: string }[];
  lessons: ShelfLesson[];
  assignments: ShelfAssignment[];
  submissions: ShelfSubmission[];
  schemes: ShelfScheme[];
  filter: TermFilter;
  now: number;
}): ShelfSubject[] {
  const { subjects, filter, now } = input;

  const lessons = input.lessons.filter((l) => matchesTerm(l, filter));
  const assignments = input.assignments.filter((a) => matchesTerm(a, filter));
  const schemes = input.schemes.filter((s) => matchesTerm(s, filter));

  /**
   * Submissions carry no term of their own here: they are matched through the
   * assignment they answer, which is the only row that was stamped. Doing it the
   * other way round would count a submission whose assignment fell outside the
   * filter.
   */
  const inFilter = new Set(assignments.map((a) => a.assignmentId));
  const submissions = input.submissions.filter((s) => inFilter.has(s.assignmentId));
  const submittedIds = new Set(submissions.map((s) => s.assignmentId));

  return subjects
    .map((subject): ShelfSubject => {
      const mine = <T extends { subjectId: string }>(rows: T[]) =>
        rows.filter((r) => r.subjectId === subject.id);

      const subjectLessons = mine(lessons);
      const subjectAssignments = mine(assignments);
      const subjectSubmissions = mine(submissions);

      let dueCount = 0;
      let overdueCount = 0;
      for (const a of subjectAssignments) {
        if (submittedIds.has(a.assignmentId)) continue;
        if (a.dueDate < now) overdueCount++;
        else dueCount++;
      }

      const finalised = subjectSubmissions.filter(
        (s) => s.isFinalised && s.finalScorePercent !== null
      );

      const lessonCount = subjectLessons.length;
      const schemeCount = mine(schemes).length;

      return {
        subjectId: subject.id,
        subjectName: subject.name,
        lessonCount,
        studyGuideCount: subjectLessons.filter((l) => l.hasStudyGuide).length,
        schemeCount,
        dueCount,
        overdueCount,
        markedCount: subjectSubmissions.filter((s) => s.isFinalised).length,
        averagePercent: mean(finalised.map((s) => s.finalScorePercent!)),
        isEmpty:
          lessonCount === 0 && schemeCount === 0 && subjectAssignments.length === 0,
      };
    })
    /**
     * Subjects with something to do sort first, then subjects with content, then
     * empty ones. A child opening this on a phone should reach the work without
     * scrolling past nine subjects nobody has uploaded to yet.
     */
    .sort((a, b) => {
      const weight = (s: ShelfSubject) =>
        s.overdueCount > 0 ? 0 : s.dueCount > 0 ? 1 : s.isEmpty ? 3 : 2;
      const wa = weight(a);
      const wb = weight(b);
      if (wa !== wb) return wa - wb;
      return a.subjectName.localeCompare(b.subjectName);
    });
}

/** Rounded to a whole percent. Null for an empty set - never 0, which is a mark. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/**
 * The three numbers above the shelf.
 *
 * Computed from the SAME filtered rows the shelf uses, by summing the shelf
 * itself rather than re-filtering the inputs. Two passes over the same data is
 * how a header ends up disagreeing with the list under it.
 */
export interface ShelfTotals {
  due: number;
  overdue: number;
  marked: number;
  lessons: number;
  subjectsWithWork: number;
}

export function shelfTotals(shelf: ShelfSubject[]): ShelfTotals {
  return shelf.reduce<ShelfTotals>(
    (totals, s) => ({
      due: totals.due + s.dueCount,
      overdue: totals.overdue + s.overdueCount,
      marked: totals.marked + s.markedCount,
      lessons: totals.lessons + s.lessonCount,
      subjectsWithWork: totals.subjectsWithWork + (s.isEmpty ? 0 : 1),
    }),
    { due: 0, overdue: 0, marked: 0, lessons: 0, subjectsWithWork: 0 }
  );
}
