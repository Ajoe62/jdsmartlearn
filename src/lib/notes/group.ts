/**
 * Grouping and search for the student's notes - "By week", "By topic", and the
 * search box.
 *
 * Pure and dependency-free, because BOTH renderers use it: the server page and
 * the offline shell reading IndexedDB. One implementation means the two cannot
 * disagree about which week a note is in. Kept small on purpose: it ships in the
 * student bundle, which has a 30 KB budget.
 */

import type { NoteKind, NoteTopic } from "@/types";

/** One note, as much as the grouping needs. */
export interface NoteRow {
  lessonId: string;
  title: string;
  kind: NoteKind;
  week: number | null;
  topics: NoteTopic[];
  hasMaterial: boolean;
  hasStudyGuide: boolean;
  hasSections: boolean;
  term: string | null;
  session: string | null;
}

/**
 * A note row from anything shaped like a lesson - a server sync entry or a row
 * on the phone. Supplies the defaults for a row saved before 2026-10-02, which
 * has no kind, week or topic list yet: a topic note, no week, shelved under the
 * one title it always showed.
 */
export function toNoteRow(l: {
  lessonId: string;
  title: string;
  topicTitle: string;
  kind?: NoteKind;
  week?: number | null;
  topics?: NoteTopic[];
  hasMaterial: boolean;
  hasStudyGuide: boolean;
  hasSections?: boolean;
  term?: string | null;
  session?: string | null;
}): NoteRow {
  return {
    lessonId: l.lessonId,
    title: l.title,
    kind: l.kind === "weekly" ? "weekly" : "topic",
    week: typeof l.week === "number" ? l.week : null,
    topics:
      l.topics && l.topics.length > 0
        ? l.topics
        : l.kind === "weekly"
          ? [] // not sorted into topics yet - see noteTopics() on the server
          : [{ id: null, title: l.topicTitle || l.title }],
    hasMaterial: l.hasMaterial,
    hasStudyGuide: l.hasStudyGuide,
    hasSections: !!l.hasSections,
    term: l.term ?? null,
    session: l.session ?? null,
  };
}

const WORDS = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
  "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen",
];

/** "Week Three". Spelled out, the way a Nigerian school timetable writes it. */
export function weekLabel(week: number | null): string {
  if (week === null) return "Week not set";
  return `Week ${WORDS[week] ?? week}`;
}

/** Topic titles compared loosely: "Fractions " and "fractions" are one topic. */
export function topicKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The in-page anchor for a topic section of a weekly note. */
export function topicAnchor(title: string): string {
  return "t-" + topicKey(title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface WeekGroup {
  week: number | null;
  notes: NoteRow[];
}

export interface TermGroup {
  /** Null for notes from before terms were recorded - shown as "Earlier". */
  term: string | null;
  session: string | null;
  weeks: WeekGroup[];
}

/**
 * Term, then week. Weeks reset each term (owner's decision, 2026-10-02), so a
 * week is only ever grouped inside its own term and session - "Week 3" of first
 * term and of second term are different weeks and never share a card.
 *
 * Newest term first, so this term is at the top. Inside a term, Week 1 first,
 * the way a child counts through it; "Week not set" last.
 */
export function groupByWeek(
  rows: NoteRow[],
  termOrder: (term: string) => number
): TermGroup[] {
  const terms = new Map<string, TermGroup>();
  for (const r of rows) {
    const dated = r.term !== null && r.session !== null;
    const key = dated ? `${r.term}\t${r.session}` : "";
    let g = terms.get(key);
    if (!g) {
      g = { term: dated ? r.term : null, session: dated ? r.session : null, weeks: [] };
      terms.set(key, g);
    }
    let w = g.weeks.find((x) => x.week === r.week);
    if (!w) {
      w = { week: r.week, notes: [] };
      g.weeks.push(w);
    }
    w.notes.push(r);
  }

  for (const g of terms.values()) {
    g.weeks.sort((a, b) => (a.week ?? 99) - (b.week ?? 99));
    // Weekly notes lead their week; topic notes follow.
    for (const w of g.weeks) {
      w.notes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "weekly" ? -1 : 1));
    }
  }

  return [...terms.values()].sort((a, b) => {
    if (a.session === null) return 1;
    if (b.session === null) return -1;
    if (a.session !== b.session) return b.session.localeCompare(a.session);
    return termOrder(b.term!) - termOrder(a.term!);
  });
}

export interface TopicEntry {
  lessonId: string;
  title: string;
  kind: NoteKind;
  week: number | null;
  /** Set on a weekly note: jump straight to this topic's section. */
  anchor: string | null;
}

export interface TopicGroup {
  title: string;
  entries: TopicEntry[];
}

/**
 * One card per topic, holding every note that covers it: topic notes whole, and
 * weekly notes by their section on that topic. Alphabetical, so a child looking
 * for "Fractions" knows where it will be.
 */
export function groupByTopic(rows: NoteRow[]): TopicGroup[] {
  const groups = new Map<string, TopicGroup>();
  for (const r of rows) {
    for (const t of r.topics) {
      const key = topicKey(t.title);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) {
        g = { title: t.title.trim(), entries: [] };
        groups.set(key, g);
      }
      if (g.entries.some((e) => e.lessonId === r.lessonId)) continue;
      g.entries.push({
        lessonId: r.lessonId,
        title: r.title,
        kind: r.kind,
        week: r.week,
        anchor: r.kind === "weekly" && r.hasSections ? topicAnchor(t.title) : null,
      });
    }
  }
  for (const g of groups.values()) {
    g.entries.sort((a, b) => (a.week ?? 99) - (b.week ?? 99));
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Does `text` contain every word of `query`? Case- and spacing-blind, and the
 * words may come in any order, so "fraction week 3" finds Week Three's note on
 * fractions.
 */
export function matchesQuery(text: string, query: string): boolean {
  const hay = searchable(text);
  return searchable(query)
    .split(" ")
    .filter(Boolean)
    // A number must match whole, or "week 3" would find Week 13. A word may
    // match a part, so "fraction" still finds "fractions".
    .every((w) => (/^\d+$/.test(w) ? new RegExp(`\\b${w}\\b`).test(hay) : hay.includes(w)));
}

/** Lower-case, spaces collapsed, and "week three" also findable as "week 3". */
export function searchable(text: string): string {
  let t = text.toLowerCase().replace(/\s+/g, " ");
  for (let i = 1; i < WORDS.length; i++) {
    t = t.replace(new RegExp(`\\bweek ${WORDS[i].toLowerCase()}\\b`, "g"), `week ${i}`);
  }
  return t;
}

/** A short piece of `text` around the first query word, for a search result. */
export function snippet(text: string, query: string, width = 90): string | null {
  const word = searchable(query).split(" ").find((w) => w.length > 2);
  if (!word) return null;
  const at = text.toLowerCase().indexOf(word);
  if (at < 0) return null;
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + piece + (start + width < text.length ? "…" : "");
}
