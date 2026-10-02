/**
 * Tests for weekly notes: sorting a week into topics, and grouping notes for the
 * student shelf.
 *
 *   npm run test:notes
 *
 * The property worth the most here is the owner's: a weekly note sorted by the
 * AI keeps the TEACHER'S WORDS. assembleSections is where that is enforced, so
 * most of these tests are about it never losing, duplicating or rewriting a
 * paragraph whatever the model answers.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleSections,
  cleanSections,
  numberedText,
  parseWeek,
  splitParagraphs,
  topicsOf,
  MAX_PARAGRAPHS,
} from "../src/lib/notes/arrange";
import {
  groupByTopic,
  groupByWeek,
  matchesQuery,
  toNoteRow,
  topicAnchor,
  weekLabel,
  type NoteRow,
} from "../src/lib/notes/group";
import { termOrder } from "../src/lib/academic-calendar";

const WEEK = [
  "Fractions",
  "A fraction is part of a whole.",
  "Half of 8 is 4.",
  "Figures of speech",
  "A simile compares using like or as.",
  "Fractions again: a quarter of 8 is 2.",
].join("\n\n");

const TOPICS = [
  { id: "t-frac", title: "Fractions" },
  { id: "t-fos", title: "Figures of speech" },
];

// ---------- splitParagraphs ----------

test("splitParagraphs splits on blank lines", () => {
  assert.equal(splitParagraphs(WEEK).length, 6);
});

test("splitParagraphs falls back to lines when a PDF has no blank lines", () => {
  assert.deepEqual(splitParagraphs("One\nTwo\nThree\nFour"), ["One", "Two", "Three", "Four"]);
});

test("splitParagraphs merges a very long note but keeps every word", () => {
  const text = Array.from({ length: MAX_PARAGRAPHS * 2 + 5 }, (_, i) => `p${i}`).join("\n\n");
  const parts = splitParagraphs(text);
  assert.ok(parts.length <= MAX_PARAGRAPHS);
  assert.equal(parts.join("\n\n"), text);
});

test("numberedText numbers paragraphs and stops at the limit", () => {
  const out = numberedText(["aaa", "bbb", "ccc"], 12);
  assert.ok(out.startsWith("[1] aaa"));
  assert.ok(!out.includes("[3]"));
});

// ---------- assembleSections ----------

const paras = splitParagraphs(WEEK);

/** Every paragraph exactly once, in the teacher's own words. */
function assertKeepsEveryWord(sections: { body: string }[]) {
  const got = sections.flatMap((s) => s.body.split("\n\n")).sort();
  assert.deepEqual(got, [...paras].sort());
}

test("assembleSections builds bodies from the teacher's paragraphs", () => {
  const sections = assembleSections(
    paras,
    [
      { heading: "Parts of a whole", topicNumber: 1, topicTitle: "", paragraphs: [1, 2, 3, 6] },
      { heading: "Similes", topicNumber: 2, topicTitle: "", paragraphs: [4, 5] },
    ],
    TOPICS,
    "Week One notes"
  );
  assert.equal(sections.length, 2);
  assert.equal(sections[0].topicId, "t-frac");
  assert.equal(sections[0].topicTitle, "Fractions");
  assert.ok(sections[0].body.includes("a quarter of 8 is 2"));
  assert.equal(sections[1].topicTitle, "Figures of speech");
  assertKeepsEveryWord(sections);
});

test("assembleSections places paragraphs the model left out", () => {
  const sections = assembleSections(
    paras,
    [
      { heading: "A", topicNumber: 1, topicTitle: "", paragraphs: [2] },
      { heading: "B", topicNumber: 2, topicTitle: "", paragraphs: [5] },
    ],
    TOPICS,
    "Week One notes"
  );
  assertKeepsEveryWord(sections);
  // Paragraph 1 (above the first placed one) joins the first section.
  assert.ok(sections[0].body.startsWith("Fractions"));
});

test("assembleSections ignores duplicate and out-of-range numbers", () => {
  const sections = assembleSections(
    paras,
    [
      { heading: "A", topicNumber: 1, topicTitle: "", paragraphs: [1, 2, 3, 99, -1, 2.5] },
      { heading: "B", topicNumber: 2, topicTitle: "", paragraphs: [3, 4, 5, 6] },
    ],
    TOPICS,
    "Week One notes"
  );
  assertKeepsEveryWord(sections);
});

test("assembleSections cannot be made to paraphrase", () => {
  // A model that ignores the instructions and writes text gets no say in the body.
  const sections = assembleSections(
    paras,
    [{ heading: "All", topicNumber: 0, topicTitle: "A REWRITTEN TOPIC", paragraphs: [1, 2, 3, 4, 5, 6] }],
    TOPICS,
    "Week One notes"
  );
  assert.equal(sections[0].body, paras.join("\n\n"));
  assert.equal(sections[0].topicId, null);
  assert.equal(sections[0].topicTitle, "A REWRITTEN TOPIC");
});

test("assembleSections with nothing usable keeps the whole note as one section", () => {
  const sections = assembleSections(paras, [], TOPICS, "Week One notes");
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "Week One notes");
  assertKeepsEveryWord(sections);
});

test("an out-of-range topic number is a new topic name, not a wrong topic", () => {
  const [s] = assembleSections(
    paras,
    [{ heading: "H", topicNumber: 7, topicTitle: "Decimals", paragraphs: [1, 2, 3, 4, 5, 6] }],
    TOPICS,
    "x"
  );
  assert.equal(s.topicId, null);
  assert.equal(s.topicTitle, "Decimals");
});

// ---------- cleanSections ----------

test("cleanSections keeps a known topic id and uses its canonical title", () => {
  const out = cleanSections(
    [{ heading: "", topicId: "t-frac", topicTitle: "fractions!!", body: "x" }],
    TOPICS
  );
  assert.ok(!("error" in out));
  assert.deepEqual(out, [{ heading: "Fractions", topicId: "t-frac", topicTitle: "Fractions", body: "x" }]);
});

test("cleanSections drops a topic id from another subject or school", () => {
  const out = cleanSections(
    [{ heading: "H", topicId: "someone-elses", topicTitle: "Mine", body: "x" }],
    TOPICS
  );
  assert.ok(!("error" in out));
  assert.equal((out as { topicId: string | null }[])[0].topicId, null);
});

test("cleanSections refuses empty notes, no topic, and non-arrays", () => {
  assert.ok("error" in (cleanSections([{ heading: "H", topicTitle: "T", body: " " }], TOPICS) as object));
  assert.ok("error" in (cleanSections([{ heading: "H", topicTitle: "", body: "x" }], TOPICS) as object));
  assert.ok("error" in (cleanSections("nope", TOPICS) as object));
  assert.ok("error" in (cleanSections([], TOPICS) as object));
});

test("topicsOf gives one label per topic", () => {
  const t = topicsOf([
    { heading: "a", topicId: "t-frac", topicTitle: "Fractions", body: "x" },
    { heading: "b", topicId: null, topicTitle: "fractions ", body: "y" },
    { heading: "c", topicId: "t-fos", topicTitle: "Figures of speech", body: "z" },
  ]);
  assert.deepEqual(t.map((x) => x.title), ["Fractions", "Figures of speech"]);
});

test("parseWeek", () => {
  assert.equal(parseWeek("3", 14), 3);
  assert.equal(parseWeek("", 14), null);
  assert.equal(parseWeek(null, 14), null);
  assert.equal(parseWeek("0", 14), undefined);
  assert.equal(parseWeek("15", 14), undefined);
  assert.equal(parseWeek("2.5", 14), undefined);
});

// ---------- grouping ----------

function row(over: Partial<NoteRow>): NoteRow {
  return {
    lessonId: "l",
    title: "Note",
    kind: "topic",
    week: null,
    topics: [{ id: null, title: "Note" }],
    hasMaterial: true,
    hasStudyGuide: true,
    hasSections: false,
    term: "First Term",
    session: "2026/2027",
    ...over,
  };
}

test("weekLabel spells the week out", () => {
  assert.equal(weekLabel(1), "Week One");
  assert.equal(weekLabel(14), "Week Fourteen");
  assert.equal(weekLabel(null), "Week not set");
});

test("groupByWeek keeps weeks inside their own term (weeks reset each term)", () => {
  const groups = groupByWeek(
    [
      row({ lessonId: "a", week: 3 }),
      row({ lessonId: "b", week: 3, term: "Second Term" }),
      row({ lessonId: "c", week: 1 }),
      row({ lessonId: "d", week: null }),
      row({ lessonId: "e", week: 2, term: null, session: null }),
    ],
    termOrder
  );
  // Newest term first, "Earlier" last.
  assert.deepEqual(groups.map((g) => g.term), ["Second Term", "First Term", null]);
  const first = groups[1];
  assert.deepEqual(first.weeks.map((w) => w.week), [1, 3, null]);
  assert.deepEqual(groups[0].weeks[0].notes.map((n) => n.lessonId), ["b"]);
});

test("groupByWeek puts the weekly note ahead of topic notes in its week", () => {
  const [g] = groupByWeek(
    [row({ lessonId: "topic", week: 2 }), row({ lessonId: "weekly", week: 2, kind: "weekly" })],
    termOrder
  );
  assert.deepEqual(g.weeks[0].notes.map((n) => n.lessonId), ["weekly", "topic"]);
});

test("groupByTopic joins topic notes and weekly sections on one topic", () => {
  const groups = groupByTopic([
    row({ lessonId: "w1", kind: "weekly", week: 1, hasSections: true, topics: [{ id: "t-frac", title: "Fractions" }, { id: null, title: "Similes" }] }),
    row({ lessonId: "t1", title: "Fractions recap", topics: [{ id: "t-frac", title: "fractions" }] }),
  ]);
  assert.deepEqual(groups.map((g) => g.title), ["Fractions", "Similes"]);
  const frac = groups[0];
  assert.equal(frac.entries.length, 2);
  assert.equal(frac.entries.find((e) => e.lessonId === "w1")!.anchor, topicAnchor("Fractions"));
  assert.equal(frac.entries.find((e) => e.lessonId === "t1")!.anchor, null);
});

test("toNoteRow reads a row saved before weekly notes existed", () => {
  const r = toNoteRow({
    lessonId: "old",
    title: "Photosynthesis",
    topicTitle: "Plants",
    hasMaterial: true,
    hasStudyGuide: false,
  });
  assert.equal(r.kind, "topic");
  assert.equal(r.week, null);
  assert.deepEqual(r.topics, [{ id: null, title: "Plants" }]);
  assert.equal(r.term, null);
});

test("search matches words in any order, and weeks spelled either way", () => {
  assert.ok(matchesQuery("Week Three Mathematics notes — Fractions", "fractions week 3"));
  assert.ok(matchesQuery("week 3", "Week Three"));
  assert.ok(!matchesQuery("Week Thirteen", "week 3"));
  assert.ok(!matchesQuery("Fractions", "decimals"));
});

test("a weekly note not yet sorted has no topics, so it stays out of By topic", () => {
  const r = toNoteRow({
    lessonId: "w",
    title: "Week Three Mathematics notes",
    topicTitle: "Week Three Mathematics notes",
    kind: "weekly",
    week: 3,
    hasMaterial: true,
    hasStudyGuide: false,
  });
  assert.deepEqual(r.topics, []);
  assert.deepEqual(groupByTopic([r]), []);
  assert.equal(groupByWeek([r], termOrder)[0].weeks[0].week, 3);
});
