/**
 * The teacher's and admin's class -> subject -> week view (owner's request,
 * 2026-10-13). Pure, so the grouping is tested without Firestore.
 *
 * The student shelf groups the same way (lib/notes/group), but over a different
 * row: a tutor row carries a status, an author and drafts, and none of that may
 * reach the student bundle. Kept apart so the 30 KB student budget does not pay
 * for tutor-only fields.
 */

import { MAX_WEEK, type ClassLevel, type LessonStatus, type NoteKind } from "@/types";

/** One lesson, as much as the week view needs. */
export interface TutorLessonRow {
  id: string;
  title: string;
  subjectId: string;
  tutorId: string;
  status: LessonStatus;
  materialPublishedAt?: number | null;
  updatedAt: number;
  kind?: NoteKind;
  week?: number | null;
  term?: string | null;
  session?: string | null;
}

export interface TermWeeks<T extends TutorLessonRow = TutorLessonRow> {
  /** Null on lessons created before terms were recorded, or before one was set. */
  term: string | null;
  session: string | null;
  /** The term new lessons land in. Shows every week, filled or not. */
  current: boolean;
  /** Week 1..MAX_WEEK. The current term lists all of them; others only filled ones. */
  weeks: { week: number; lessons: T[] }[];
  /** Topic notes with no week yet - the "No week set" section, with a Move button. */
  noWeek: T[];
}

/**
 * Term, then week. Weeks reset each term (owner's decision, 2026-10-02), so a
 * week is only ever grouped inside its own term and session.
 *
 * `current` is the school's current term, or null when an admin has not set one.
 * New lessons are stamped with it, so it is the group a teacher is filling: it
 * always comes first and always lists Week One to Week Fourteen, so an empty
 * week shows as a gap with an "Add" button rather than being absent. With no
 * current term set, new lessons carry no term, so the undated group plays that
 * part instead.
 *
 * Other terms follow, newest first, showing only the weeks that have something.
 */
export function groupTutorWeeks<T extends TutorLessonRow>(
  lessons: T[],
  current: { term: string; session: string } | null,
  termOrder: (term: string) => number
): TermWeeks<T>[] {
  const keyOf = (term: string | null, session: string | null) =>
    term !== null && session !== null ? `${term}\t${session}` : "";
  const currentKey = current ? keyOf(current.term, current.session) : "";

  const groups = new Map<string, TermWeeks<T>>();
  const groupFor = (term: string | null, session: string | null) => {
    const key = keyOf(term, session);
    let g = groups.get(key);
    if (!g) {
      const dated = key !== "";
      g = {
        term: dated ? term : null,
        session: dated ? session : null,
        current: key === currentKey,
        weeks: [],
        noWeek: [],
      };
      groups.set(key, g);
    }
    return g;
  };

  // The current term exists even before its first lesson, so its empty weeks show.
  groupFor(current?.term ?? null, current?.session ?? null);

  for (const l of lessons) {
    const g = groupFor(l.term ?? null, l.session ?? null);
    const week = typeof l.week === "number" ? l.week : null;
    if (week === null) {
      g.noWeek.push(l);
      continue;
    }
    let w = g.weeks.find((x) => x.week === week);
    if (!w) {
      w = { week, lessons: [] };
      g.weeks.push(w);
    }
    w.lessons.push(l);
  }

  for (const g of groups.values()) {
    if (g.current) {
      for (let week = 1; week <= MAX_WEEK; week++) {
        if (!g.weeks.some((w) => w.week === week)) g.weeks.push({ week, lessons: [] });
      }
    }
    g.weeks.sort((a, b) => a.week - b.week);
    for (const w of g.weeks) {
      // Weekly notes lead their week; topic notes follow.
      w.lessons.sort((a, b) =>
        (a.kind === "weekly") === (b.kind === "weekly")
          ? b.updatedAt - a.updatedAt
          : a.kind === "weekly"
            ? -1
            : 1
      );
    }
    g.noWeek.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return [...groups.values()]
    .filter((g) => g.current || g.weeks.length > 0 || g.noWeek.length > 0)
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.session === null) return 1;
      if (b.session === null) return -1;
      if (a.session !== b.session) return b.session.localeCompare(a.session);
      return termOrder(b.term!) - termOrder(a.term!);
    });
}

/** How far a subject has got this term, for the subject card on a class page. */
export interface SubjectProgress {
  lessons: number;
  /** Distinct weeks with at least one lesson, in the current group. */
  weeksCovered: number;
  /** Study guides finished and waiting for the teacher to review. */
  toReview: number;
}

export function subjectProgress(lessons: TutorLessonRow[]): SubjectProgress {
  const weeks = new Set<number>();
  let toReview = 0;
  for (const l of lessons) {
    if (typeof l.week === "number") weeks.add(l.week);
    if (l.status === "generated") toReview++;
  }
  return { lessons: lessons.length, weeksCovered: weeks.size, toReview };
}

/** The four stages a Nigerian school is organised in, for the admin's class list. */
export type SchoolStage = "early" | "primary" | "junior" | "senior" | "other";

export const STAGE_LABELS: Record<SchoolStage, string> = {
  early: "Nursery",
  primary: "Primary",
  junior: "Junior secondary",
  senior: "Senior secondary",
  other: "Other classes",
};

const STAGE_ORDER: SchoolStage[] = ["early", "primary", "junior", "senior", "other"];

export function stageOf(level: ClassLevel | undefined): SchoolStage {
  if (!level) return "other";
  if (level === "PN" || level.startsWith("N")) return "early";
  if (level.startsWith("P")) return "primary";
  if (level.startsWith("JSS")) return "junior";
  if (level.startsWith("SS")) return "senior";
  return "other";
}

/**
 * Classes grouped by stage, youngest first, each stage in name order. A class
 * whose level cannot be read from ResultPeak goes under "Other classes" rather
 * than being guessed into a stage.
 */
export function groupByStage<T extends { name: string; level?: ClassLevel }>(
  classes: T[]
): { stage: SchoolStage; classes: T[] }[] {
  const by = new Map<SchoolStage, T[]>();
  for (const c of classes) {
    const s = stageOf(c.level);
    by.set(s, [...(by.get(s) ?? []), c]);
  }
  return STAGE_ORDER.filter((s) => by.has(s)).map((stage) => ({
    stage,
    classes: by
      .get(stage)!
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  }));
}

/**
 * What an "Add" link on the subject page fills in on a new-lesson, assignment or
 * scheme form. Read from the URL and CHECKED against what the form offers: a
 * prefill is a convenience, and a class or subject the tutor may not pick is
 * dropped rather than shown. Every route re-checks the pair server-side anyway.
 */
export interface Prefill {
  classId: string;
  subjectId: string;
  week: number | null;
  kind: NoteKind | null;
}

export function parsePrefill(
  params: { get(name: string): string | null },
  allowed: {
    classIds: string[];
    subjectsForClass: (classId: string) => string[];
  }
): Prefill {
  const classId = params.get("class") ?? "";
  const subjectId = params.get("subject") ?? "";
  const okClass = allowed.classIds.includes(classId);
  const okSubject = okClass && allowed.subjectsForClass(classId).includes(subjectId);
  const weekRaw = Number(params.get("week"));
  const week = Number.isInteger(weekRaw) && weekRaw >= 1 && weekRaw <= MAX_WEEK ? weekRaw : null;
  const kindRaw = params.get("kind");
  return {
    classId: okClass ? classId : "",
    subjectId: okSubject ? subjectId : "",
    week,
    kind: kindRaw === "weekly" || kindRaw === "topic" ? kindRaw : null,
  };
}

/** The subject page for a class and subject. One place, so every back link agrees. */
export function subjectHref(classId: string, subjectId: string): string {
  return `/tutor/classes/${encodeURIComponent(classId)}/subjects/${encodeURIComponent(subjectId)}`;
}

export function classHref(classId: string): string {
  return `/tutor/classes/${encodeURIComponent(classId)}`;
}

/**
 * Where a form goes after saving, when it was opened from a subject page. Only
 * a subject page path is accepted - never an arbitrary URL from the query string.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\/tutor\/classes\/[^/?#]+\/subjects\/[^/?#]+$/.test(value) ? value : null;
}
