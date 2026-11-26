/**
 * Student lists must not silently drop work. Run: npm run test:lists
 *
 * Until 2026-11-26 a class's assignments and a student's own submissions were
 * each read at most 50 at a time, unordered and across every school year, so
 * past 50 an arbitrary set fell off the child's screen. See src/lib/list-cap.ts.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { capWarning } from "../src/lib/list-cap";

test("a list that comes back full is reported, with where it happened", () => {
  const w = capWarning("class assignments", 200, 200, { schoolId: "s1", classId: "c1", session: null });
  assert.ok(w);
  assert.match(w!, /\[list-cap\] class assignments returned 200 of limit 200/);
  assert.match(w!, /schoolId=s1 classId=c1 session=-/);
});

test("a list under its limit is not reported", () => {
  assert.equal(capWarning("student submissions", 199, 200, {}), null);
  assert.equal(capWarning("student submissions", 0, 200, {}), null);
});

// ---------------------------------------------------------------------------
// Source checks
// ---------------------------------------------------------------------------

const code = (p: string) =>
  readFileSync(path.join(__dirname, "..", p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

/** The body of one exported function, up to the next top-level export. */
function fn(file: string, name: string): string {
  const src = code(file);
  const start = src.search(new RegExp(`export (async )?function ${name}\\b`));
  assert.ok(start >= 0, `${name} not found in ${file}`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next);
}

const STUDENT_LISTS: [string, string][] = [
  ["src/lib/db/assignments.ts", "listActiveAssignmentsForClass"],
  ["src/lib/db/submissions.ts", "listSubmissionsForStudent"],
];

for (const [file, name] of STUDENT_LISTS) {
  test(`${name} reads a whole school year, not an arbitrary 50`, () => {
    const body = fn(file, name);
    assert.doesNotMatch(body, /LIST_LIMIT/, "the old 50 cap is back");
    assert.match(body, /\.limit\(QUERY_LIMIT\)/);
    assert.match(body, /where\("session", "==", session\)/, "no school-year filter");
    assert.match(body, /reportIfCapped\(/, "a full result would go unnoticed");
  });

  test(`${name} needs no composite index: equality filters only, no orderBy`, () => {
    const body = fn(file, name);
    assert.doesNotMatch(body, /\.orderBy\(/);
    assert.doesNotMatch(body, /where\([^)]*"(<|<=|>|>=|!=|not-in|array-contains)"/);
  });
}

test("the class list is not filtered by term, which would hide holiday work for next term", () => {
  const body = fn("src/lib/db/assignments.ts", "listActiveAssignmentsForClass");
  assert.doesNotMatch(body, /where\("term"/);
});

test("published schemes are not capped at 50 before drafts are dropped", () => {
  const body = fn("src/lib/db/schemes.ts", "listPublishedSchemesForClass");
  assert.doesNotMatch(body, /LIST_LIMIT/);
  assert.match(body, /reportIfCapped\(/);
});

test("the subject shelf uses the shared class list, not its own query per child", () => {
  const shelf = code("src/lib/db/subject-shelf.ts");
  assert.doesNotMatch(shelf, /listActiveAssignmentsForClass/);
  assert.match(shelf, /loadAssignmentsForStudent\(/);
});

test("the phone's sync reads the student's own work once, not twice", () => {
  const route = code("src/app/api/student/assignments/sync/route.ts");
  assert.doesNotMatch(route, /listSubmissionsForStudent\(/);
  assert.doesNotMatch(route, /buildAssignmentList\(/);
  assert.match(route, /loadAssignmentsForStudent\(/);
});

test("the cached class list reads the year and its cache key changed with its shape", () => {
  const body = fn("src/lib/db/submissions.ts", "getClassAssignments");
  assert.match(body, /getCurrentTermSession\(/);
  assert.match(body, /"class-assignments-v2"/);
});

test("the cached class list still strips the marking guide", () => {
  const body = fn("src/lib/db/submissions.ts", "getClassAssignments");
  assert.doesNotMatch(body, /markingGuide/);
});
