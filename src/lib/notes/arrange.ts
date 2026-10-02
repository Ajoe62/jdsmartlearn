/**
 * Sorting a weekly note into topic sections - THE TUTOR'S WORDS, NOT THE MODEL'S.
 *
 * Owner's decision, 2026-10-02: when the AI arranges a week's notes by topic it
 * keeps the teacher's own wording. That is enforced here by construction rather
 * than asked of the model: the lesson is split into numbered paragraphs, the
 * model answers only with paragraph NUMBERS per topic, and the section bodies are
 * assembled from the lesson's own paragraphs. A model that paraphrases, shortens
 * or invents has nowhere to put the result.
 *
 * It also makes the call small and fast: the model's output is a few numbers per
 * section instead of the whole week's notes written out a second time.
 *
 * Pure - no Firestore, no provider - so it is tested directly
 * (scripts/test-notes.ts) and shared by the generate and publish routes.
 */

import type { NoteSection, NoteTopic } from "@/types";

/** More paragraphs than this are merged in runs, to keep the prompt bounded. */
export const MAX_PARAGRAPHS = 300;
/** A week with more topics than this is not a week. */
export const MAX_SECTIONS = 12;
/** What a tutor may publish after editing - looser than the model's limit. */
export const MAX_PUBLISHED_SECTIONS = 20;
export const MAX_HEADING_CHARS = 120;
export const MAX_SECTION_CHARS = 50_000;
export const MAX_SECTIONS_TOTAL_CHARS = 200_000;

/**
 * Split lesson text into paragraphs.
 *
 * Blank lines first. Text extracted from a PDF often has no blank lines at all,
 * only single line breaks, so when blank lines give almost nothing this falls
 * back to lines. A lone heading line becomes its own paragraph, which is what
 * lets the model place it.
 */
export function splitParagraphs(text: string): string[] {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];

  let parts = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) {
    const lines = clean.split("\n").map((p) => p.trim()).filter(Boolean);
    if (lines.length > parts.length) parts = lines;
  }

  if (parts.length <= MAX_PARAGRAPHS) return parts;

  // Merge neighbours in fixed runs. Order is kept, so the numbering still reads
  // top to bottom and nothing is lost.
  const run = Math.ceil(parts.length / MAX_PARAGRAPHS);
  const merged: string[] = [];
  for (let i = 0; i < parts.length; i += run) {
    merged.push(parts.slice(i, i + run).join("\n\n"));
  }
  return merged;
}

/**
 * The lesson as the model sees it: `[n] paragraph`, one per block.
 *
 * Stops before `maxChars`. Paragraphs past the cut are still kept - they are
 * placed with the section before them by assembleSections - so a long week is
 * never truncated, only arranged on the strength of its first part.
 */
export function numberedText(paragraphs: string[], maxChars: number): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, p] of paragraphs.entries()) {
    const line = `[${i + 1}] ${p}`;
    if (used + line.length > maxChars && out.length > 0) break;
    out.push(line);
    used += line.length + 2;
  }
  return out.join("\n\n");
}

/** One section as the model returns it. Numbers only - see the file comment. */
export interface ArrangedSection {
  heading: string;
  /** 1-based index into the candidate topic list, or 0 for "none of these". */
  topicNumber: number;
  /** The model's name for the topic when topicNumber is 0. */
  topicTitle: string;
  /** 1-based paragraph numbers. */
  paragraphs: number[];
}

/**
 * Build the sections from the model's paragraph numbers and the lesson's own
 * paragraphs.
 *
 * Never trusts the numbers: out-of-range and duplicate paragraphs are ignored,
 * and a paragraph the model left out goes with the section before it (or after
 * it, at the very top), so EVERY paragraph of the teacher's notes ends up in
 * exactly one section. A model that answers with nothing usable yields one
 * section holding the whole note, which the tutor can split on review.
 */
export function assembleSections(
  paragraphs: string[],
  arranged: ArrangedSection[],
  candidates: { id: string; title: string }[],
  fallbackHeading: string
): NoteSection[] {
  if (paragraphs.length === 0) return [];

  const owner = new Array<number>(paragraphs.length).fill(-1);
  arranged.slice(0, MAX_SECTIONS).forEach((s, si) => {
    for (const n of s.paragraphs ?? []) {
      const i = n - 1;
      if (Number.isInteger(i) && i >= 0 && i < paragraphs.length && owner[i] === -1) {
        owner[i] = si;
      }
    }
  });

  if (owner.every((o) => o === -1)) {
    return [
      {
        heading: fallbackHeading,
        topicId: null,
        topicTitle: fallbackHeading,
        body: paragraphs.join("\n\n"),
      },
    ];
  }

  // Unplaced paragraphs follow the one before them...
  let last = -1;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === -1) owner[i] = last;
    else last = owner[i];
  }
  // ...and any at the very top go with the first section below them.
  let next = -1;
  for (let i = owner.length - 1; i >= 0; i--) {
    if (owner[i] === -1) owner[i] = next;
    else next = owner[i];
  }

  // Sections in the order their first paragraph appears in the note.
  const order: number[] = [];
  for (const o of owner) if (!order.includes(o)) order.push(o);

  return order.map((si) => {
    const s = arranged[si];
    const body = paragraphs.filter((_, i) => owner[i] === si).join("\n\n");
    const topic =
      Number.isInteger(s.topicNumber) && s.topicNumber >= 1 && s.topicNumber <= candidates.length
        ? candidates[s.topicNumber - 1]
        : null;
    const topicTitle = clip(topic?.title ?? s.topicTitle ?? "", MAX_HEADING_CHARS);
    const heading = clip(s.heading ?? "", MAX_HEADING_CHARS) || topicTitle || fallbackHeading;
    return {
      heading,
      topicId: topic?.id ?? null,
      topicTitle: topicTitle || heading,
      body,
    };
  });
}

/**
 * Validate sections a tutor sends back from the review screen.
 *
 * A topic id is kept only if it names a topic this school has for this subject;
 * then its canonical title wins over whatever the form sent, so two weeks that
 * both cover "Fractions" group together on the student shelf. Anything else is
 * kept as a plain topic name with no id - a tutor may name a topic that has no
 * document, and that is not an error.
 *
 * Returns a message instead of throwing, for the route to send back verbatim.
 */
export function cleanSections(
  input: unknown,
  allowedTopics: { id: string; title: string }[]
): NoteSection[] | { error: string } {
  if (!Array.isArray(input)) return { error: "The topic sections didn't come through. Reload and try again." };
  if (input.length === 0) return { error: "Keep at least one topic section." };
  if (input.length > MAX_PUBLISHED_SECTIONS) {
    return { error: `Use at most ${MAX_PUBLISHED_SECTIONS} topic sections.` };
  }

  const byId = new Map(allowedTopics.map((t) => [t.id, t]));
  const out: NoteSection[] = [];
  let total = 0;

  for (const raw of input) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const heading = typeof r.heading === "string" ? r.heading.trim() : "";
    const body = typeof r.body === "string" ? r.body.trim() : "";
    const named = typeof r.topicTitle === "string" ? r.topicTitle.trim() : "";
    const topic = typeof r.topicId === "string" ? byId.get(r.topicId) : undefined;

    if (!body) return { error: "A topic section is empty. Add its notes or remove it." };
    if (body.length > MAX_SECTION_CHARS) return { error: "A topic section is too long. Split it in two." };
    const topicTitle = topic?.title ?? named;
    if (!topicTitle) return { error: "Give every section a topic." };
    if (topicTitle.length > MAX_HEADING_CHARS || heading.length > MAX_HEADING_CHARS) {
      return { error: `Keep section names under ${MAX_HEADING_CHARS} characters.` };
    }

    total += body.length;
    out.push({
      heading: heading || topicTitle,
      topicId: topic?.id ?? null,
      topicTitle,
      body,
    });
  }

  if (total > MAX_SECTIONS_TOTAL_CHARS) return { error: "These notes are too long for one week. Split them across two notes." };
  return out;
}

/** Distinct topics in section order. Two sections on one topic make one label. */
export function topicsOf(sections: NoteSection[]): NoteTopic[] {
  const seen = new Set<string>();
  const out: NoteTopic[] = [];
  for (const s of sections) {
    const key = s.topicTitle.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: s.topicId, title: s.topicTitle });
  }
  return out;
}

/** Parse a week from a form or JSON value. Null for blank; undefined for invalid. */
export function parseWeek(raw: unknown, max: number): number | null | undefined {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw));
  return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
}

function clip(s: string, n: number): string {
  return s.trim().slice(0, n);
}
