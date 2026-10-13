/**
 * Tests for the tutor's and admin's class -> subject -> week view.
 *
 *   npm run test:tutor-shelf
 *
 * The properties worth holding: the term being filled always shows all fourteen
 * weeks; weeks never mix across terms; a topic note with no week lands under
 * "No week set" instead of disappearing; and a prefill from the URL never
 * offers a class or subject the tutor may not pick.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  groupByStage,
  groupTutorWeeks,
  parsePrefill,
  safeReturnTo,
  stageOf,
  subjectProgress,
  type TutorLessonRow,
} from "../src/lib/tutor-shelf";
import { termOrder } from "../src/lib/academic-calendar";
import { MAX_WEEK } from "../src/types";

const FIRST = { term: "First Term", session: "2026/2027" };
const THIRD_LAST = { term: "Third Term", session: "2025/2026" };

let n = 0;
function row(over: Partial<TutorLessonRow>): TutorLessonRow {
  n++;
  return {
    id: `l${n}`,
    title: `Lesson ${n}`,
    subjectId: "maths",
    tutorId: "t1",
    status: "draft",
    updatedAt: n,
    kind: "weekly",
    week: 1,
    ...FIRST,
    ...over,
  };
}

test("the current term lists every week, filled or not", () => {
  const groups = groupTutorWeeks([row({ week: 3 })], FIRST, termOrder);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].current, true);
  assert.deepEqual(
    groups[0].weeks.map((w) => w.week),
    Array.from({ length: MAX_WEEK }, (_, i) => i + 1)
  );
  assert.equal(groups[0].weeks[2].lessons.length, 1);
  assert.equal(groups[0].weeks[0].lessons.length, 0);
});

test("the current term shows even with no lessons at all", () => {
  const groups = groupTutorWeeks([], FIRST, termOrder);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].weeks.length, MAX_WEEK);
});

test("week 3 of two terms never share a group; current term first", () => {
  const groups = groupTutorWeeks(
    [row({ week: 3, ...THIRD_LAST }), row({ week: 3 })],
    FIRST,
    termOrder
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].term, "First Term");
  assert.equal(groups[1].term, "Third Term");
  // An earlier term lists only the weeks it has.
  assert.deepEqual(groups[1].weeks.map((w) => w.week), [3]);
});

test("a topic note with no week goes under No week set", () => {
  const loose = row({ kind: "topic", week: null });
  const groups = groupTutorWeeks([loose], FIRST, termOrder);
  assert.deepEqual(groups[0].noWeek.map((l) => l.id), [loose.id]);
  assert.ok(groups[0].weeks.every((w) => w.lessons.length === 0));
});

test("an older lesson with no week field at all is not lost", () => {
  const old = row({ kind: undefined, week: undefined });
  const groups = groupTutorWeeks([old], FIRST, termOrder);
  assert.equal(groups[0].noWeek.length, 1);
});

test("with no current term, the undated group is the one being filled", () => {
  const undated = row({ term: null, session: null, week: 2 });
  const groups = groupTutorWeeks([undated], null, termOrder);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].current, true);
  assert.equal(groups[0].term, null);
  assert.equal(groups[0].weeks.length, MAX_WEEK);
});

test("undated lessons come after dated terms once a term is set", () => {
  const groups = groupTutorWeeks(
    [row({ term: null, session: null, week: 1 }), row({ week: 1, ...THIRD_LAST })],
    FIRST,
    termOrder
  );
  assert.deepEqual(
    groups.map((g) => g.term),
    ["First Term", "Third Term", null]
  );
});

test("weekly notes lead their week", () => {
  const topic = row({ kind: "topic", week: 4, updatedAt: 100 });
  const weekly = row({ kind: "weekly", week: 4, updatedAt: 1 });
  const groups = groupTutorWeeks([topic, weekly], FIRST, termOrder);
  assert.deepEqual(groups[0].weeks[3].lessons.map((l) => l.id), [weekly.id, topic.id]);
});

test("subject progress counts distinct weeks and work to review", () => {
  const p = subjectProgress([
    row({ week: 1, status: "generated" }),
    row({ week: 1 }),
    row({ week: 2, status: "published" }),
    row({ week: null, kind: "topic" }),
  ]);
  assert.deepEqual(p, { lessons: 4, weeksCovered: 2, toReview: 1 });
});

test("classes group by stage, youngest first, in natural order", () => {
  assert.equal(stageOf("PN"), "early");
  assert.equal(stageOf("N2"), "early");
  assert.equal(stageOf("P4"), "primary");
  assert.equal(stageOf("JSS1"), "junior");
  assert.equal(stageOf("SS3"), "senior");
  assert.equal(stageOf(undefined), "other");

  const grouped = groupByStage([
    { name: "SS 1", level: "SS1" as const },
    { name: "Primary 10", level: "P6" as const },
    { name: "Primary 2", level: "P2" as const },
    { name: "Nursery 1", level: "N1" as const },
    { name: "Clubs", level: undefined },
  ]);
  assert.deepEqual(
    grouped.map((g) => g.stage),
    ["early", "primary", "senior", "other"]
  );
  assert.deepEqual(grouped[1].classes.map((c) => c.name), ["Primary 2", "Primary 10"]);
});

function params(q: string) {
  return new URLSearchParams(q);
}
const allowed = {
  classIds: ["jss2", "jss3"],
  subjectsForClass: (id: string) => (id === "jss2" ? ["maths", "english"] : ["maths"]),
};

test("a prefill keeps an allowed class, subject and week", () => {
  assert.deepEqual(parsePrefill(params("class=jss2&subject=english&week=5&kind=weekly"), allowed), {
    classId: "jss2",
    subjectId: "english",
    week: 5,
    kind: "weekly",
  });
});

test("a prefill drops a class the tutor does not hold, and its subject with it", () => {
  const p = parsePrefill(params("class=ss1&subject=maths"), allowed);
  assert.equal(p.classId, "");
  assert.equal(p.subjectId, "");
});

test("a prefill drops a subject the tutor does not teach in that class", () => {
  const p = parsePrefill(params("class=jss3&subject=english"), allowed);
  assert.equal(p.classId, "jss3");
  assert.equal(p.subjectId, "");
});

test("a prefill refuses a week outside 1..MAX_WEEK", () => {
  for (const w of ["0", "15", "2.5", "abc", ""]) {
    assert.equal(parsePrefill(params(`class=jss2&week=${w}`), allowed).week, null, w);
  }
});

test("returnTo only ever points at a subject page", () => {
  assert.equal(safeReturnTo("/tutor/classes/jss2/subjects/maths"), "/tutor/classes/jss2/subjects/maths");
  assert.equal(safeReturnTo("https://evil.example/tutor/classes/a/subjects/b"), null);
  assert.equal(safeReturnTo("//evil.example"), null);
  assert.equal(safeReturnTo("/tutor/classes/a/subjects/b?x=1"), null);
  assert.equal(safeReturnTo(undefined), null);
});
