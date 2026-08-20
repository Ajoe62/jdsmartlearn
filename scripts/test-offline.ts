/**
 * Tests for the pure offline sync logic.
 *
 * These two files are where a bug is expensive: planSync decides what a student's
 * phone shows, so getting it wrong means serving a lesson the tutor withdrew.
 * Everything here is pure - no IndexedDB, no fetch, no DOM.
 *
 *   npm run test:offline
 *
 * Uses node:test so this needs no new dependency (tsx is already installed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  batched,
  dayKey,
  evictionPlan,
  groupBySubject,
  planSync,
  type LocalLessonState,
} from "../src/lib/offline/merge";
import { collapse, isLocalId, type OutboxOp } from "../src/lib/offline/collapse";
import {
  RESULTPEAK_TERMS,
  isKnownSession,
  isKnownTerm,
  sortSessionsDescending,
  termOrder,
} from "../src/lib/academic-calendar";
import { assertRecordFields } from "../src/lib/db/write-guard";
import { readOnlyDb } from "../src/lib/db/read-only";
import {
  auditTermSessions,
  formatReport,
  pairKey,
  visible,
  type JdRow,
  type RpRow,
} from "../src/lib/assessment/term-session-audit";
import {
  averagePercentage,
  decideCaTarget,
  denormalizedFrom,
} from "../src/lib/assessment/ca";
import {
  GRADING_ATTEMPT_CAP,
  isStuck,
  selectExhausted,
  selectStuck,
  type SweepCandidate,
} from "../src/lib/assessment/grading-recovery";
import { SKIP_ORDER, SKIP_TEXT, detectSkips } from "../src/lib/assessment/skips";
import { claimRefusal } from "../src/lib/auth/claims";
import {
  isUnallocated,
  teachesSubject,
  teachesSubjectInClass,
  teachableMap,
  subjectsForClass,
  classesForSubject,
  type SubjectAllocation,
} from "../src/lib/auth/subject-access";
import {
  toStudentAssignment,
  toStudentSubmissionPayload,
} from "../src/lib/assessment/projection";
import {
  DEFAULT_ALLOWED_FILE_TYPES,
  MAX_SUBMISSION_FILE_BYTES,
  SUBMITTABLE_TYPES,
  extensionOf,
  rejectAttachment,
  resolveAllowedFileTypes,
} from "../src/lib/storage/file-types";
import type { Claims, SyncIndexEntry } from "../src/types";
import type { Assignment, AssignmentSubmission } from "../src/types/student-dashboard";

function entry(over: Partial<SyncIndexEntry> = {}): SyncIndexEntry {
  return {
    lessonId: "l1",
    title: "Photosynthesis",
    topicTitle: "Photosynthesis",
    subjectId: "biology",
    subjectName: "Biology",
    hasMaterial: true,
    hasStudyGuide: true,
    updatedAt: 1000,
    file: null,
    ...over,
  };
}

function local(over: Partial<LocalLessonState> = {}): LocalLessonState {
  return { lessonId: "l1", updatedAt: 1000, hasStudyGuide: true, ...over };
}

test("planSync fetches a guide the device has never seen", () => {
  const plan = planSync([entry()], []);
  assert.deepEqual(plan.fetchGuides, ["l1"]);
  assert.deepEqual(plan.remove, []);
  // Nothing to invalidate - the device held no material for it.
  assert.deepEqual(plan.staleMaterials, []);
});

test("planSync leaves an unchanged lesson alone", () => {
  const plan = planSync([entry()], [local()]);
  assert.deepEqual(plan.fetchGuides, []);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.staleMaterials, []);
});

test("planSync re-fetches when updatedAt moved, and drops the stale material", () => {
  const plan = planSync([entry({ updatedAt: 2000 })], [local({ updatedAt: 1000 })]);
  assert.deepEqual(plan.fetchGuides, ["l1"]);
  assert.deepEqual(plan.staleMaterials, ["l1"]);
});

test("planSync fetches when a lesson newly gained a guide", () => {
  const plan = planSync([entry()], [local({ hasStudyGuide: false })]);
  assert.deepEqual(plan.fetchGuides, ["l1"]);
});

test("planSync does not fetch a guide the server says does not exist", () => {
  const plan = planSync(
    [entry({ hasStudyGuide: false })],
    [local({ hasStudyGuide: false })]
  );
  assert.deepEqual(plan.fetchGuides, []);
});

test("planSync removes anything the index no longer lists", () => {
  // This is the unpublish / delete / moved-class path. The index is the only
  // authority on what exists.
  const plan = planSync([], [local({ lessonId: "gone" })]);
  assert.deepEqual(plan.remove, ["gone"]);
});

test("planSync removes only the missing lessons, keeping the rest", () => {
  const plan = planSync(
    [entry({ lessonId: "keep" })],
    [local({ lessonId: "keep" }), local({ lessonId: "drop" })]
  );
  assert.deepEqual(plan.remove, ["drop"]);
  assert.deepEqual(plan.fetchGuides, []);
});

test("planSync handles a whole class moving under the device", () => {
  const plan = planSync(
    [entry({ lessonId: "new1" }), entry({ lessonId: "new2" })],
    [local({ lessonId: "old1" }), local({ lessonId: "old2" })]
  );
  assert.deepEqual(plan.remove, ["old1", "old2"]);
  assert.deepEqual(plan.fetchGuides, ["new1", "new2"]);
});

test("batched splits to fixed sizes and keeps order", () => {
  assert.deepEqual(batched([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batched([], 10), []);
  assert.deepEqual(batched([1], 10), [[1]]);
  assert.throws(() => batched([1], 0));
});

test("evictionPlan does nothing under the cap", () => {
  const items = [{ lessonId: "a", bytes: 100, savedAt: 1 }];
  assert.deepEqual(evictionPlan(items, 1000), []);
});

test("evictionPlan drops least-recently-saved first, and only enough", () => {
  const items = [
    { lessonId: "newest", bytes: 400, savedAt: 300 },
    { lessonId: "oldest", bytes: 400, savedAt: 100 },
    { lessonId: "middle", bytes: 400, savedAt: 200 },
  ];
  // 1200 total, cap 800 -> must free 400, so exactly the oldest goes.
  assert.deepEqual(evictionPlan(items, 800), ["oldest"]);
});

test("evictionPlan never drops a protected lesson", () => {
  const items = [
    { lessonId: "oldest", bytes: 500, savedAt: 100 },
    { lessonId: "newer", bytes: 500, savedAt: 200 },
  ];
  // The lesson being read right now must survive even though it is oldest.
  assert.deepEqual(evictionPlan(items, 400, ["oldest"]), ["newer"]);
});

test("groupBySubject groups, sorts by subject name, and keeps lesson order", () => {
  const groups = groupBySubject([
    { lessonId: "b1", title: "Cells", subjectId: "bio", subjectName: "Biology", hasMaterial: true, hasStudyGuide: true },
    { lessonId: "a1", title: "Nouns", subjectId: "eng", subjectName: "English", hasMaterial: true, hasStudyGuide: false },
    { lessonId: "b2", title: "Leaves", subjectId: "bio", subjectName: "Biology", hasMaterial: false, hasStudyGuide: true },
  ]);

  assert.deepEqual(groups.map((g) => g.subjectName), ["Biology", "English"]);
  assert.deepEqual(groups[0].lessons.map((l) => l.lessonId), ["b1", "b2"]);
});

test("groupBySubject on nothing returns nothing", () => {
  assert.deepEqual(groupBySubject([]), []);
});

test("dayKey is a UTC date string, matching the server's dayKey", () => {
  assert.equal(dayKey(Date.UTC(2026, 6, 26, 23, 59)), "2026-07-26");
  // 00:30 WAT on the 27th is still the 26th in UTC - the same rule the
  // generation cap already uses.
  assert.equal(dayKey(Date.UTC(2026, 6, 26, 23, 30)), "2026-07-26");
});

// ---------- tutor outbox collapsing ----------
//
// These are the tests that stand in for the dependency graph we DIDN'T build.
// If collapsing regresses, offline tutor writes need `local:` id rewriting again.

const CREATE: OutboxOp = {
  kind: "create",
  target: "local:a",
  title: "Fractions",
  classId: "c1",
  topicId: "t1",
  text: "x".repeat(300),
};

test("isLocalId distinguishes device ids from server ids", () => {
  assert.equal(isLocalId("local:a"), true);
  assert.equal(isLocalId("abc123"), false);
});

test("collapse folds a later patch into the create, so no chaining is needed", () => {
  const out = collapse([
    CREATE,
    { kind: "patch", target: "local:a", title: "Fractions, part 1", baseUpdatedAt: 0 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "create");
  assert.equal((out[0] as typeof CREATE).title, "Fractions, part 1");
});

test("collapse keeps the LAST value when a field is edited repeatedly", () => {
  const out = collapse([
    CREATE,
    { kind: "patch", target: "local:a", title: "second", baseUpdatedAt: 0 },
    { kind: "patch", target: "local:a", title: "third", baseUpdatedAt: 0 },
  ]);
  assert.equal(out.length, 1);
  assert.equal((out[0] as typeof CREATE).title, "third");
});

test("collapse folds a material publish into the create", () => {
  const out = collapse([CREATE, { kind: "material", target: "local:a", publish: true }]);
  assert.equal(out.length, 1);
  assert.equal((out[0] as typeof CREATE).publishMaterial, true);
});

test("collapse sends NOTHING for a lesson created then deleted offline", () => {
  // It never existed on the server; uploading then deleting would be pure waste.
  assert.deepEqual(collapse([CREATE, { kind: "delete", target: "local:a" }]), []);
});

test("collapse reduces a deleted server lesson to just the delete", () => {
  const out = collapse([
    { kind: "patch", target: "L1", title: "pointless", baseUpdatedAt: 5 },
    { kind: "material", target: "L1", publish: true },
    { kind: "delete", target: "L1" },
  ]);
  assert.deepEqual(out, [{ kind: "delete", target: "L1" }]);
});

test("collapse merges patches on a server lesson and keeps the OLDEST baseline", () => {
  // The oldest baseline is the state the tutor actually started from, so the
  // staleness check stays honest.
  const out = collapse([
    { kind: "patch", target: "L1", title: "a", baseUpdatedAt: 100 },
    { kind: "patch", target: "L1", text: "body", baseUpdatedAt: 200 },
  ]);
  assert.equal(out.length, 1);
  const patch = out[0] as { title?: string; text?: string; baseUpdatedAt: number };
  assert.equal(patch.title, "a");
  assert.equal(patch.text, "body");
  assert.equal(patch.baseUpdatedAt, 100);
});

test("collapse keeps only the final material state", () => {
  const out = collapse([
    { kind: "material", target: "L1", publish: true },
    { kind: "material", target: "L1", publish: false },
  ]);
  assert.deepEqual(out, [{ kind: "material", target: "L1", publish: false }]);
});

test("collapse preserves first-seen order across different lessons", () => {
  const out = collapse([
    { kind: "material", target: "L2", publish: true },
    CREATE,
    { kind: "patch", target: "L2", title: "later", baseUpdatedAt: 1 },
  ]);
  // L2 was touched first, so L2's ops come first.
  assert.equal(out[0].target, "L2");
  assert.equal(out[out.length - 1].target, "local:a");
});

test("collapse leaves independent lessons independent", () => {
  const out = collapse([
    CREATE,
    { kind: "delete", target: "L9" },
    { kind: "patch", target: "L8", title: "kept", baseUpdatedAt: 3 },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((o) => o.target),
    ["local:a", "L9", "L8"]
  );
});

// ---------------------------------------------------------------------------
// collapse: marking
// ---------------------------------------------------------------------------

const MARK: OutboxOp = {
  kind: "mark",
  target: "S1",
  release: false,
  teacherScore: 12,
  teacherComment: null,
  baseUpdatedAt: 500,
};

test("collapse keeps only the tutor's LAST mark for one submission", () => {
  const out = collapse([
    MARK,
    { ...MARK, teacherScore: 15 },
    { ...MARK, teacherScore: 18, teacherComment: "Good work" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "mark");
  assert.equal((out[0] as typeof MARK).teacherScore, 18);
  assert.equal((out[0] as typeof MARK).teacherComment, "Good work");
});

test("collapse keeps the OLDEST baseline across repeated marks", () => {
  // The tutor started from the state at 500; a later op recording 900 must not
  // weaken the staleness check into accepting a version they never saw.
  const out = collapse([
    { ...MARK, baseUpdatedAt: 500 },
    { ...MARK, baseUpdatedAt: 900 },
  ]);
  assert.equal((out[0] as typeof MARK).baseUpdatedAt, 500);
});

test("collapse keeps a release, not the draft that preceded it", () => {
  const out = collapse([MARK, { ...MARK, release: true, teacherScore: 20 }]);
  assert.equal(out.length, 1);
  assert.equal((out[0] as typeof MARK).release, true);
  assert.equal((out[0] as typeof MARK).teacherScore, 20);
});

test("collapse leaves marks on different submissions independent", () => {
  const out = collapse([MARK, { ...MARK, target: "S2", teacherScore: 5 }]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((o) => o.target),
    ["S1", "S2"]
  );
});

test("collapse keeps a mark alongside unrelated lesson work", () => {
  const out = collapse([CREATE, MARK]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, "create");
  assert.equal(out[1].kind, "mark");
});

// ---------------------------------------------------------------------------
// Term and session: exact strings, no normalisation, frozen at creation
// ---------------------------------------------------------------------------

test("the three terms match ResultPeak's strings byte for byte", () => {
  // Duplicated as a hardcoded TERMS array in ExamCoverageGrid.tsx:39,
  // ExamForm.tsx:20 and ManageExamsPage.jsx:36 in the ResultPeak repo.
  assert.deepEqual(
    [...RESULTPEAK_TERMS],
    ["First Term", "Second Term", "Third Term"]
  );
});

test("term membership is exact: no trim, no case folding", () => {
  assert.equal(isKnownTerm("First Term"), true);
  // Every one of these joins to nothing on a ResultPeak result sheet, so every
  // one of them must be refused rather than tidied into the real value.
  assert.equal(isKnownTerm(" First Term"), false);
  assert.equal(isKnownTerm("First Term "), false);
  assert.equal(isKnownTerm("first term"), false);
  assert.equal(isKnownTerm("FIRST TERM"), false);
  assert.equal(isKnownTerm("First  Term"), false);
  assert.equal(isKnownTerm("Term 1"), false);
  assert.equal(isKnownTerm("1"), false);
  assert.equal(isKnownTerm(""), false);
});

test("session membership is exact against the school's observed values", () => {
  const known = ["2026/2027", "2025/2026"];
  assert.equal(isKnownSession("2025/2026", known), true);
  assert.equal(isKnownSession("2025/2026 ", known), false);
  assert.equal(isKnownSession("2025-2026", known), false);
  assert.equal(isKnownSession("2024/2025", known), false);
  assert.equal(isKnownSession("", known), false);
});

test("a session absent from observed values is rejected without an override", () => {
  // Mirrors the check in /api/tutor/school-settings: without the explicit
  // override, a session the school's own exams and results never carried is
  // refused, because CA written under it joins to nothing.
  const observed = ["2025/2026"];
  const chosen = "2027/2028";
  const acceptedWithoutOverride = observed.includes(chosen);
  assert.equal(acceptedWithoutOverride, false);

  // With the override the value is accepted AND added to knownSessions, which is
  // what makes it usable on the write path afterwards.
  const knownSessions = observed.includes(chosen) ? observed : [chosen, ...observed];
  assert.deepEqual(knownSessions, ["2027/2028", "2025/2026"]);
  assert.equal(isKnownSession(chosen, knownSessions), true);
});

test("an assignment keeps its original term after the school setting moves on", () => {
  // The assignment stamps once at creation. Nothing re-reads the setting.
  const setting = { term: "First Term", session: "2025/2026" };
  const assignment = { term: setting.term, session: setting.session };

  // The school rolls forward mid-year.
  setting.term = "Third Term";
  setting.session = "2026/2027";

  assert.equal(assignment.term, "First Term");
  assert.equal(assignment.session, "2025/2026");

  // And the submission copies the ASSIGNMENT, never the setting.
  const submission = { term: assignment.term, session: assignment.session };
  assert.equal(submission.term, "First Term");
  assert.equal(submission.session, "2025/2026");
});

test("term order is derived, never stored", () => {
  assert.equal(termOrder("First Term"), 0);
  assert.equal(termOrder("Second Term"), 1);
  assert.equal(termOrder("Third Term"), 2);
  // Unknown sorts last rather than throwing: this is presentation only.
  assert.equal(termOrder("Fourth Term"), 3);
});

test("sessions sort newest first", () => {
  assert.deepEqual(
    sortSessionsDescending(["2024/2025", "2026/2027", "2025/2026"]),
    ["2026/2027", "2025/2026", "2024/2025"]
  );
});

// ---------------------------------------------------------------------------
// Continuous assessment: nested shape, no fallback, term and session scoping
// ---------------------------------------------------------------------------

test("assertRecordFields accepts the nested CA shape", () => {
  assert.doesNotThrow(() =>
    assertRecordFields({
      schoolId: "S1",
      studentId: "ST1",
      continuousAssessment: { biology: { first_assessment: 72 } },
      lastUpdatedByLMS: 1,
    })
  );
});

test("assertRecordFields refuses every ResultPeak-owned field", () => {
  for (const key of [
    "examScore",
    "examScore.biology",
    "combinedScore",
    "grade",
    "lastUpdatedByAssessment",
  ]) {
    assert.throws(
      () => assertRecordFields({ [key]: 1 }),
      /Refusing to write/,
      `expected ${key} to be refused`
    );
  }
});

test("assertRecordFields refuses an unknown field root, not just ResultPeak's", () => {
  // The point of an allowlist. A guard that enumerated the other platform's
  // fields would let every one of these through, and would need editing each
  // time ResultPeak invented a field.
  for (const key of ["foo", "notes", "continuousAssessmentX", "CONTINUOUSASSESSMENT"]) {
    assert.throws(
      () => assertRecordFields({ [key]: 1 }),
      /Refusing to write/,
      `expected ${key} to be refused`
    );
  }
  // And it does not blame ResultPeak for a field neither platform has heard of.
  assert.throws(
    () => assertRecordFields({ foo: 1 }),
    /is not one of them/,
    "an unknown root must not be attributed to ResultPeak"
  );
});

test("assertRecordFields refuses a bad value reached by a dotted path", () => {
  // The dotted forms are the same write as the nested one; Firestore deep-merges
  // either way. Checking only `update.continuousAssessment` skipped all of these
  // and let a raw mark, a string, and a map-where-a-number-belongs straight
  // through into a document the other platform reads as report card input.
  assert.throws(
    () => assertRecordFields({ "continuousAssessment.biology": { exam: 9999 } }),
    /percentages from 0 to 100/
  );
  assert.throws(
    () => assertRecordFields({ "continuousAssessment.biology.exam": 9999 }),
    /percentages from 0 to 100/
  );
  assert.throws(
    () => assertRecordFields({ "continuousAssessment.biology.exam": "hack" }),
    /not a number/
  );
  assert.throws(
    () => assertRecordFields({ "continuousAssessment.biology": 72 }),
    /expected a map of/
  );
  // Accepted: the same score, correctly shaped, at each of the three depths.
  for (const update of [
    { continuousAssessment: { biology: { exam: 72 } } },
    { "continuousAssessment.biology": { exam: 72 } },
    { "continuousAssessment.biology.exam": 72 },
  ]) {
    assert.doesNotThrow(() => assertRecordFields(update));
  }
});

test("assertRecordFields refuses a path that runs past the end of a field", () => {
  assert.throws(
    () => assertRecordFields({ "continuousAssessment.a.b.c": 1 }),
    /reaches past the end of it/
  );
  assert.throws(
    () => assertRecordFields({ "lastUpdatedByLMS.x": 1 }),
    /reaches past the end of it/
  );
  assert.throws(
    () => assertRecordFields({ "continuousAssessment..exam": 1 }),
    /empty path segment/
  );
});

test("assertRecordFields refuses a map where a scalar belongs", () => {
  // A map here deep-merges too, and both platforms read lastUpdatedByLMS as a
  // timestamp.
  assert.throws(
    () => assertRecordFields({ lastUpdatedByLMS: { nested: true } }),
    /expected a timestamp number/
  );
  assert.throws(() => assertRecordFields({ schoolId: "" }), /non-empty string/);
});

test("assertRecordFields refuses a flat number per subject", () => {
  // The old shape. ResultPeak models CA as several named components per subject,
  // so a single blended number could never be placed in any of its columns.
  assert.throws(
    () => assertRecordFields({ continuousAssessment: { biology: 72 } }),
    /expected a map of/
  );
});

test("assertRecordFields refuses raw marks masquerading as percentages", () => {
  assert.throws(
    () => assertRecordFields({ continuousAssessment: { biology: { exam: 140 } } }),
    /percentages from 0 to 100/
  );
  assert.throws(
    () => assertRecordFields({ continuousAssessment: { biology: { exam: -1 } } }),
    /percentages from 0 to 100/
  );
  assert.throws(
    () => assertRecordFields({ continuousAssessment: { biology: { exam: NaN } } }),
    /not a number/
  );
});

test("CA sync does not run while the assessment type mapping is unset", () => {
  // Mirrors syncContinuousAssessment: an unset mapping is a skip with a reason,
  // never a write into whichever type happened to be first. CAPSTONE ACADEMY has
  // no coursework column at all, so a fallback would file homework under an exam.
  const reason = (t: ReturnType<typeof decideCaTarget>) =>
    t.status === "skipped" ? t.reason : "ready";

  assert.equal(reason(decideCaTarget(null, [])), "no_settings");
  assert.equal(reason(decideCaTarget({ lmsAssessmentType: null }, ["exam"])), "mapping_unset");
  assert.equal(
    reason(decideCaTarget({ lmsAssessmentType: "h_assignment" }, ["first_assessment", "exam"])),
    "type_removed"
  );

  const ready = decideCaTarget({ lmsAssessmentType: "first_assessment" }, [
    "first_assessment",
    "exam",
  ]);
  assert.equal(ready.status, "ready");
  assert.equal(ready.status === "ready" ? ready.assessmentTypeId : null, "first_assessment");
});

test("CA recalculation excludes finalised submissions from another term or session", () => {
  // The shape of the six equality filters in listFinalisedForSubject.
  const rows = [
    { term: "First Term", session: "2025/2026", finalScore: 10, maxMarks: 10 },
    { term: "Third Term", session: "2025/2026", finalScore: 2, maxMarks: 10 },
    { term: "First Term", session: "2026/2027", finalScore: 0, maxMarks: 10 },
    { term: "First Term", session: "2025/2026", finalScore: 6, maxMarks: 10 },
  ];
  const scoped = rows.filter((r) => r.term === "First Term" && r.session === "2025/2026");

  assert.equal(scoped.length, 2);
  // 100% and 60% average to 80%. Without the session filter the 0 from
  // 2026/2027 would drag it to 53%, and without the term filter further still.
  assert.equal(averagePercentage(scoped), 80);
  assert.equal(averagePercentage(rows), 45);
});

test("a submission write that omits a denormalised field is caught", () => {
  // denormalizedFrom is the single place these are copied from the assignment.
  // Every field below is required by a query or a security rule downstream.
  const required = [
    "schoolId",
    "assignmentId",
    "classId",
    "subjectId",
    "term",
    "session",
    "tutorId",
    "assignmentTitle",
    "subjectName",
    "maxMarks",
  ];
  const assignment = {
    id: "A1",
    schoolId: "S1",
    classId: "C1",
    subjectId: "biology",
    term: "First Term",
    session: "2025/2026",
    tutorId: "T1",
    title: "Photosynthesis",
    subjectName: "Biology",
    maxMarks: 10,
  };
  const written = denormalizedFrom(assignment as Parameters<typeof denormalizedFrom>[0]);

  for (const field of required) {
    assert.ok(field in written, `denormalizedFrom must copy ${field}`);
    assert.notEqual(
      (written as Record<string, unknown>)[field],
      undefined,
      `${field} must not be undefined`
    );
  }
  // Copied from the ASSIGNMENT, not from the current school setting.
  assert.equal(written.term, "First Term");
  assert.equal(written.session, "2025/2026");
});

// ---------------------------------------------------------------------------
// Grading recovery: the sweep picks stuck rows, ignores in-flight ones, and stops
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const SWEEP = { now: NOW, thresholdMs: 10 * MINUTE, cap: GRADING_ATTEMPT_CAP };

function candidate(over: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    id: "A1_S1",
    status: "ai_grading",
    submittedAt: NOW - 30 * MINUTE,
    gradingAttempts: 1,
    lastGradingAttemptAt: NOW - 30 * MINUTE,
    ...over,
  };
}

test("the sweep selects a submission whose grading trigger never landed", () => {
  assert.equal(isStuck(candidate(), SWEEP), true);
});

test("the sweep ignores a submission still in flight", () => {
  // Grading takes 20 to 40 seconds. Anything inside the threshold is presumed
  // running, not lost, so a sweep on every page load never double-sends.
  assert.equal(isStuck(candidate({ lastGradingAttemptAt: NOW - 30_000 }), SWEEP), false);
  assert.equal(
    isStuck(candidate({ lastGradingAttemptAt: NOW - 9 * MINUTE }), SWEEP),
    false
  );
  // Exactly at the threshold is stuck.
  assert.equal(
    isStuck(candidate({ lastGradingAttemptAt: NOW - 10 * MINUTE }), SWEEP),
    true
  );
});

test("the sweep never touches a status that is finished or the tutor's", () => {
  for (const status of ["ai_graded", "teacher_reviewed", "finalised", "ai_grading_failed"]) {
    assert.equal(isStuck(candidate({ status }), SWEEP), false, `${status} must be left alone`);
  }
  // Both sweepable statuses are picked up. "submitted" means no trigger ever
  // fired; "ai_grading" means one fired and never came back.
  assert.equal(isStuck(candidate({ status: "submitted" }), SWEEP), true);
  assert.equal(isStuck(candidate({ status: "ai_grading" }), SWEEP), true);
});

test("the sweep stops after the attempt cap", () => {
  assert.equal(isStuck(candidate({ gradingAttempts: GRADING_ATTEMPT_CAP }), SWEEP), false);
  assert.equal(
    isStuck(candidate({ gradingAttempts: GRADING_ATTEMPT_CAP + 5 }), SWEEP),
    false
  );
  // One below the cap still gets its last go.
  assert.equal(isStuck(candidate({ gradingAttempts: GRADING_ATTEMPT_CAP - 1 }), SWEEP), true);
});

test("capped rows are surfaced as exhausted rather than retried silently", () => {
  const rows = [
    candidate({ id: "capped", gradingAttempts: GRADING_ATTEMPT_CAP }),
    candidate({ id: "stuck", gradingAttempts: 1 }),
    candidate({ id: "done", status: "finalised", gradingAttempts: GRADING_ATTEMPT_CAP }),
  ];
  assert.deepEqual(
    selectExhausted(rows, SWEEP).map((r) => r.id),
    ["capped"]
  );
  assert.deepEqual(
    selectStuck(rows, SWEEP).map((r) => r.id),
    ["stuck"]
  );
});

test("the sweep serves the longest wait first", () => {
  const rows = [
    candidate({ id: "recent", lastGradingAttemptAt: NOW - 11 * MINUTE }),
    candidate({ id: "oldest", lastGradingAttemptAt: NOW - 90 * MINUTE }),
    candidate({ id: "middle", lastGradingAttemptAt: NOW - 40 * MINUTE }),
  ];
  assert.deepEqual(
    selectStuck(rows, SWEEP).map((r) => r.id),
    ["oldest", "middle", "recent"]
  );
});

// ---------------------------------------------------------------------------
// A stuck or failed submission must never leak an AI score
// ---------------------------------------------------------------------------

test("no status except finalised releases an AI score to the student", () => {
  // Mirrors toStudentSubmissionPayload: `released` gates every graded field, so
  // an unrecognised status falls through to null rather than to a number.
  const graded = {
    finalScore: 18,
    aiFeedback: "well done",
    aiStrengths: ["clear"],
    aiImprovements: ["units"],
    topicsMastered: ["photosynthesis"],
    teacherComment: "good",
  };
  const project = (status: string) => {
    const released = status === "finalised";
    return {
      finalScore: released ? graded.finalScore : null,
      feedback: released ? graded.aiFeedback : null,
      strengths: released ? graded.aiStrengths : null,
      improvements: released ? graded.aiImprovements : null,
      topicsMastered: released ? graded.topicsMastered : null,
      teacherComment: released ? graded.teacherComment : null,
    };
  };

  for (const status of [
    "submitted",
    "ai_grading",
    "ai_graded",
    "ai_grading_failed",
    "teacher_reviewed",
    "something_added_in_2027",
    "",
  ]) {
    const out = project(status);
    for (const [field, value] of Object.entries(out)) {
      assert.equal(value, null, `${status} must not expose ${field}`);
    }
  }

  assert.equal(project("finalised").finalScore, 18);
});

// ---------------------------------------------------------------------------
// The skip surface: one list, every active condition
// ---------------------------------------------------------------------------

const SETTINGS_OK = { lmsAssessmentType: "first_assessment" };
const TYPES_OK = ["first_assessment", "second_assessment", "exam"];

test("nothing to say when marking is on and the mapping is good", () => {
  assert.deepEqual(
    detectSkips({
      gradingEnabled: true,
      settings: SETTINGS_OK,
      knownAssessmentTypeIds: TYPES_OK,
    }),
    []
  );
});

test("every active skip condition is reported, not just the first", () => {
  // This is the whole reason the surface is a list. A school can have marking
  // switched off AND no assessment type mapped; a tutor shown only one of them
  // fixes it and believes the loop is working.
  assert.deepEqual(
    detectSkips({
      gradingEnabled: false,
      settings: { lmsAssessmentType: null },
      knownAssessmentTypeIds: TYPES_OK,
    }),
    ["grading_disabled", "mapping_unset"]
  );

  // No settings at all, with marking off, is also two problems.
  assert.deepEqual(
    detectSkips({ gradingEnabled: false, settings: null, knownAssessmentTypeIds: [] }),
    ["grading_disabled", "no_settings"]
  );
});

test("each CA condition is detected on its own, with no substitution", () => {
  assert.deepEqual(
    detectSkips({ gradingEnabled: true, settings: null, knownAssessmentTypeIds: TYPES_OK }),
    ["no_settings"]
  );
  assert.deepEqual(
    detectSkips({
      gradingEnabled: true,
      settings: { lmsAssessmentType: null },
      knownAssessmentTypeIds: TYPES_OK,
    }),
    ["mapping_unset"]
  );
  // The mapped type was dropped from the school record in ResultPeak. Reported,
  // never quietly redirected to another column.
  assert.deepEqual(
    detectSkips({
      gradingEnabled: true,
      settings: { lmsAssessmentType: "h_assignment" },
      knownAssessmentTypeIds: TYPES_OK,
    }),
    ["type_removed"]
  );
});

test("skips come back in a fixed order, widest problem first", () => {
  const all = detectSkips({
    gradingEnabled: false,
    settings: { lmsAssessmentType: "gone" },
    knownAssessmentTypeIds: TYPES_OK,
  });
  // Order follows SKIP_ORDER, not the order the conditions were checked in.
  const positions = all.map((reason) => SKIP_ORDER.indexOf(reason));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(all[0], "grading_disabled");
});

test("every skip reason has text, so a fifth condition cannot render blank", () => {
  for (const reason of SKIP_ORDER) {
    const text = SKIP_TEXT[reason];
    assert.equal(typeof text, "string", `${reason} has no text`);
    assert.ok(text.length > 20, `${reason} text is too short to help anyone`);
    // Never name the system at a teacher: no environment variables, no
    // collection names (CLAUDE.md, Interface writing).
    assert.ok(
      !/INTERNAL_TASK_SECRET|firestore|jdSchoolSettings/i.test(text),
      `${reason} text names the system`
    );
  }
  // SKIP_ORDER must cover the whole union, or a detected reason renders nothing.
  assert.deepEqual(
    [...SKIP_ORDER].sort(),
    Object.keys(SKIP_TEXT).sort(),
    "SKIP_ORDER and SKIP_TEXT have drifted"
  );
});

// ---------------------------------------------------------------------------
// allowedFileTypes: absent is not the same as empty
// ---------------------------------------------------------------------------

test("an assignment that never chose accepts what a student can hand in", () => {
  // Assignments written before the field existed read back as null or undefined.
  // Treating that as [] would refuse a photo of an exercise book that no tutor
  // decided to refuse.
  assert.deepEqual(resolveAllowedFileTypes(null), [...DEFAULT_ALLOWED_FILE_TYPES]);
  assert.deepEqual(resolveAllowedFileTypes(undefined), [...DEFAULT_ALLOWED_FILE_TYPES]);
});

test("an empty list is a real answer: typed answers only", () => {
  assert.deepEqual(resolveAllowedFileTypes([]), []);
});

test("a chosen list is passed through exactly, as a copy", () => {
  assert.deepEqual(resolveAllowedFileTypes([".pdf", ".jpg"]), [".pdf", ".jpg"]);
  const stored = [".pdf"];
  const resolved = resolveAllowedFileTypes(stored);
  resolved.push(".exe");
  assert.deepEqual(stored, [".pdf"], "resolving must not mutate the stored array");
  assert.deepEqual(
    resolveAllowedFileTypes(null),
    [...SUBMITTABLE_TYPES],
    "resolving must not mutate the default"
  );
});

test("a file type outside the assignment's list is rejected", () => {
  // The server calls exactly this. A tutor who ticked only .pdf must not receive
  // a .png, however the request was built.
  const onlyPdf = [".pdf"];
  assert.equal(rejectAttachment({ name: "work.pdf", size: 1000 }, onlyPdf), null);
  assert.match(
    rejectAttachment({ name: "photo.png", size: 1000 }, onlyPdf) ?? "",
    /not a file type your teacher accepts/
  );
  // Named in the message, so a student with three files knows which to replace.
  assert.match(
    rejectAttachment({ name: "photo.png", size: 1000 }, onlyPdf) ?? "",
    /photo\.png/
  );
});

test("a type no assignment could allow is rejected even if it is on the list", () => {
  // Two gates. A stored list containing ".exe" - a hand-edited document, or a
  // request that reached the tutor route before it filtered - still cannot get an
  // executable past the submittable set, because nothing can read one.
  assert.match(
    rejectAttachment({ name: "payload.exe", size: 10 }, [".exe", ".pdf"]) ?? "",
    /not a file type your teacher accepts/
  );
});

test("the extension is taken from the LAST dot", () => {
  // "answer.pdf.exe" is an .exe. Checking the first extension would accept a
  // name chosen to look like a document.
  assert.equal(extensionOf("answer.pdf.exe"), ".exe");
  assert.equal(extensionOf("answer.PDF"), ".pdf");
  assert.equal(extensionOf("noextension"), "");
  assert.equal(extensionOf(".hidden"), "", "a leading dot is not an extension");
  assert.match(
    rejectAttachment({ name: "answer.pdf.exe", size: 10 }, [".pdf"]) ?? "",
    /not a file type/
  );
});

test("an empty allowed list refuses every file, a null list accepts the defaults", () => {
  // The distinction the whole helper exists for. [] is a tutor's decision that
  // this assignment is typed answers only; null is no decision at all.
  assert.match(
    rejectAttachment({ name: "work.pdf", size: 10 }, []) ?? "",
    /not a file type your teacher accepts/
  );
  assert.equal(rejectAttachment({ name: "work.pdf", size: 10 }, null), null);
  assert.equal(rejectAttachment({ name: "work.pdf", size: 10 }, undefined), null);
});

test("an oversized file is refused before its type is considered", () => {
  const message = rejectAttachment(
    { name: "huge.pdf", size: MAX_SUBMISSION_FILE_BYTES + 1 },
    [".pdf"]
  );
  assert.match(message ?? "", /too large/);
  assert.equal(
    rejectAttachment({ name: "fine.pdf", size: MAX_SUBMISSION_FILE_BYTES }, [".pdf"]),
    null,
    "exactly at the limit is allowed"
  );
});

test("nothing is offered that the grading path cannot read", () => {
  // extract/text.ts handles pdf, docx and txt; images go to the vision path.
  // Anything else would be offered to a tutor and then grade as a blank answer.
  const readable = [".pdf", ".docx", ".txt", ".jpg", ".jpeg", ".png"];
  for (const ext of SUBMITTABLE_TYPES) {
    assert.ok(readable.includes(ext), `${ext} is offered but has no extractor`);
  }
  for (const ext of DEFAULT_ALLOWED_FILE_TYPES) {
    assert.ok(readable.includes(ext), `${ext} is a default but has no extractor`);
  }
});

// ---------------------------------------------------------------------------
// The student-safe projections: no guide, and no score before release
// ---------------------------------------------------------------------------

/** A fully graded submission, as it sits on the document before release. */
function graded(over: Partial<AssignmentSubmission> = {}): AssignmentSubmission {
  return {
    id: "a1_st1",
    schoolId: "capstone",
    assignmentId: "a1",
    studentId: "st1",
    classId: "c1",
    subjectId: "biology",
    term: "First Term" as AssignmentSubmission["term"],
    session: "2025/2026" as AssignmentSubmission["session"],
    tutorId: "t1",
    assignmentTitle: "Photosynthesis",
    subjectName: "Biology",
    maxMarks: 20,
    submittedAt: 1000,
    content: "My answer",
    attachments: [],
    status: "ai_graded",
    gradingAttempts: 1,
    lastGradingAttemptAt: 1000,
    aiScore: 17,
    aiMaxScore: 20,
    aiConfidence: "high",
    aiFeedback: "Good work",
    aiStrengths: ["clear"],
    aiImprovements: ["add detail"],
    topicsMastered: ["light"],
    topicsToRevise: ["chlorophyll"],
    teacherScore: null,
    teacherComment: "not for the child yet",
    finalScore: 17,
    finalisedAt: null,
    updatedAt: 1000,
    ...over,
  };
}

/** Every field the projection must withhold until a tutor releases the mark. */
const WITHHELD = [
  "finalScore",
  "finalisedAt",
  "feedback",
  "strengths",
  "improvements",
  "topicsToRevise",
  "topicsMastered",
  "teacherComment",
] as const;

test("an unrecognised status leaks no AI score to the student projection", () => {
  // The point of testing `status === "finalised"` positively. A status from an
  // older or newer build, or a hand-edited document, must withhold the mark
  // rather than fall through to it because nobody added it to a denylist.
  const unknown = graded({
    status: "some_future_status" as AssignmentSubmission["status"],
  });
  const view = toStudentSubmissionPayload(unknown, [{ topic: "x", lessonId: null }]);

  for (const field of WITHHELD) {
    assert.equal(view[field], null, `${field} leaked on an unrecognised status`);
  }
  // The status itself still travels: the child is told their work is in.
  assert.equal(view.status, "some_future_status");
});

test("no status except finalised releases a mark", () => {
  const statuses: AssignmentSubmission["status"][] = [
    "submitted",
    "ai_grading",
    "ai_graded",
    "ai_grading_failed",
    "teacher_reviewed",
  ];
  for (const status of statuses) {
    const view = toStudentSubmissionPayload(graded({ status }), [
      { topic: "x", lessonId: null },
    ]);
    for (const field of WITHHELD) {
      assert.equal(view[field], null, `${field} leaked at status ${status}`);
    }
  }

  // And finalised does release it, so the test above is not vacuous.
  const released = toStudentSubmissionPayload(
    graded({ status: "finalised", finalisedAt: 2000 })
  );
  assert.equal(released.finalScore, 17);
  assert.equal(released.feedback, "Good work");
  assert.equal(released.teacherComment, "not for the child yet");
});

test("a stuck or failed submission carries no number at all", () => {
  // CLAUDE.md: two failed attempts hand the work to the tutor. The child must
  // see status text and nothing resembling a score.
  const failed = toStudentSubmissionPayload(graded({ status: "ai_grading_failed" }));
  const serialized = JSON.stringify(failed);
  assert.ok(!serialized.includes("17"), "the AI score appears in the payload");
  assert.ok(!/aiScore|aiConfidence|aiMaxScore/.test(serialized), "an AI field survived");
});

test("the student assignment projection has no field a marking guide could occupy", () => {
  const safe = toStudentAssignment({
    id: "a1",
    schoolId: "capstone",
    classId: "c1",
    className: "JSS 3",
    subjectId: "biology",
    subjectName: "Biology",
    tutorId: "t1",
    title: "Photosynthesis",
    description: "Answer in your own words",
    type: "written",
    dueDate: 5000,
    maxMarks: 20,
    markingGuide: "SECRET-GUIDE-TEXT",
    linkedLessonId: null,
    allowedFileTypes: null,
    term: "First Term" as Assignment["term"],
    session: "2025/2026" as Assignment["session"],
    isActive: true,
    createdAt: 1,
    updatedAt: 2,
  });

  assert.ok(
    !JSON.stringify(safe).includes("SECRET-GUIDE-TEXT"),
    "the marking guide reached a student projection"
  );
  assert.ok(!("markingGuide" in safe), "the projection has a markingGuide key");
  assert.ok(!("tutorId" in safe), "the projection carries the tutor id");
  // null resolves to the default here, once, so no student surface has to.
  assert.deepEqual(safe.allowedFileTypes, [...DEFAULT_ALLOWED_FILE_TYPES]);
});

// ---------------------------------------------------------------------------
// claimRefusal: a claim comparison alone is not an authorization check
// ---------------------------------------------------------------------------

/** A claim set as ResultPeak stamps it on a working tutor. */
function claims(over: Partial<Claims> = {}): Partial<Claims> {
  return { role: "tutor", schoolId: "capstone", active: true, ...over };
}

test("a working tutor is allowed", () => {
  assert.equal(claimRefusal(claims()), null);
});

test("a deactivated account is refused", () => {
  assert.equal(claimRefusal(claims({ active: false })), "inactive");
});

test("a token carrying no active claim at all is refused", () => {
  // The check reads `active !== true`, not `active === false`. Written the
  // permissive way this passed, while ResultPeak's isActiveClaim() rejected it:
  // the two disagreeing in that direction is the whole 2026-08-12 incident.
  assert.equal(claimRefusal({ role: "tutor", schoolId: "capstone" }), "inactive");
});

test("a temporary password is refused even though the account reads active", () => {
  // ResultPeak's password reset preserves the claims and sets active: true, so
  // schoolId and active both still say yes. Only mustChangePassword says no.
  const stillOnTempPassword = claims({
    role: "schooladmin",
    superadmin: true,
    mustChangePassword: true,
  });
  assert.equal(stillOnTempPassword.active, true, "the trap: it still reads active");
  assert.equal(claimRefusal(stillOnTempPassword), "must_change_password");
});

test("an admin gets no exemption from any of it", () => {
  // The admin branch of assertClassAccess returns early, so an admin admitted
  // by mistake reaches every class in the school. Refusal is judged with no
  // regard for role, which is what keeps that branch out of reach.
  const admin: Partial<Claims> = { role: "schooladmin", superadmin: true, schoolId: "capstone" };
  assert.equal(claimRefusal({ ...admin, active: false }), "inactive");
  assert.equal(
    claimRefusal({ ...admin, active: true, mustChangePassword: true }),
    "must_change_password"
  );
});

test("an invited admin with no school yet is refused for the right reason", () => {
  // ResultPeak's "invited" state: role and active are set, schoolId is not.
  // The reason drives the message, so naming it wrongly sends the teacher to
  // change a password that is not the problem.
  assert.equal(
    claimRefusal({ role: "schooladmin", active: true, mustChangePassword: true }),
    "no_school"
  );
});

// ---------------------------------------------------------------------------
// Module boundary: the pure modules stay pure
// ---------------------------------------------------------------------------

/**
 * These modules are deliberately NOT marked `server-only`, so this file can
 * exercise the real rules that decide a child's mark, or decide whether an
 * account may act at all, rather than a copy of them. That freedom is what this
 * test pays for: nothing in them may reach the Admin SDK, a secret, or a module
 * that does.
 *
 * Add a module here the moment you drop `server-only` from one, wherever it
 * lives. The list is not folder-scoped, and a module missing from it is not
 * merely untested: an unlisted module is not a legal value-import target for
 * anything on the list either.
 */
const PURE_MODULES = [
  "src/lib/assessment/ca.ts",
  "src/lib/assessment/grading-recovery.ts",
  "src/lib/assessment/skips.ts",
  // The term and session audit. Pure so the byte-for-byte comparison can be
  // tested with strings that differ by one invisible character, which is the
  // whole failure mode and is not something a live project reliably contains.
  "src/lib/assessment/term-session-audit.ts",
  // The two student-safe projections. These decide whether a marking guide or an
  // unreleased AI score can reach a child's phone, so of everything on this list
  // they are the ones most worth testing against the real function.
  "src/lib/assessment/projection.ts",
  // Not assessment: the claim check behind every tutor request. Pure for the
  // same reason, and the same rules apply to it.
  "src/lib/auth/claims.ts",
  // The (class, subject) allocation check. Pure because the legacy fallback is
  // the whole risk of that feature - an unallocated tutor must pass every check
  // - and that is worth testing against the real function, not a copy.
  "src/lib/auth/subject-access.ts",
  // Reached as a value import by projection.ts, so it must be held to the rules
  // too or that import would not be legal.
  "src/lib/storage/file-types.ts",
];

/** Never importable, as a type or otherwise. */
const FORBIDDEN = [
  "server-only",
  "firebase-admin",
  "@/lib/firebase/",
  "@/lib/db/",
  "@google/generative-ai",
  "@aws-sdk/",
  "next/headers",
  "next/server",
];

/**
 * Whether a value import stays inside the pure set.
 *
 * Checking every module on the list gives this transitivity for free: a value
 * import may only reach another module that is itself held to these rules.
 */
function isPureSpecifier(spec: string, fromModule: string): boolean {
  const target = spec.startsWith(".")
    ? path.posix.join(path.posix.dirname(fromModule), spec)
    : spec.replace(/^@\//, "src/");
  return PURE_MODULES.some((m) => m === target || m === `${target}.ts`);
}

/** True when a clause names only types, as in `{ type A, type B }`. */
function bindsTypesOnly(clause: string): boolean {
  const braced = /^\s*\{([\s\S]*)\}\s*$/.exec(clause);
  if (!braced) return false;
  const names = (braced[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  // One value binding among the types makes the whole import a value import.
  return names.length > 0 && names.every((name) => /^type\s+\w/.test(name));
}

/** Every import in a file, and whether it is erased at compile time. */
function importsOf(source: string): { spec: string; typeOnly: boolean }[] {
  const found: { spec: string; typeOnly: boolean }[] = [];
  let match: RegExpExecArray | null;

  // Side-effect import: `import "server-only";`. No bindings, never erased, and
  // the single most important line this whole check exists to catch.
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((match = bare.exec(source)) !== null) {
    found.push({ spec: match[1] as string, typeOnly: false });
  }

  // `import ... from "x"` and `export ... from "x"`. The clause cannot contain a
  // semicolon, which is what stops it running past the end of one statement.
  const withClause = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)from\s+["']([^"']+)["']/g;
  while ((match = withClause.exec(source)) !== null) {
    found.push({
      spec: match[3] as string,
      typeOnly: Boolean(match[1]) || bindsTypesOnly(match[2] ?? ""),
    });
  }

  return found;
}

/**
 * What is wrong with one module's imports, in words, or an empty list.
 *
 * Takes the source rather than reading it, so the rules can be tested against
 * violations directly. Importing a real module that breaks them would fail this
 * whole file at load time with a resolver error, which proves nothing about the
 * rule and tells the next person nothing about what they did.
 */
function importViolations(rel: string, source: string): string[] {
  const problems: string[] = [];
  for (const { spec, typeOnly } of importsOf(source)) {
    if (FORBIDDEN.some((banned) => spec.startsWith(banned))) {
      problems.push(`${rel} imports ${spec}, which belongs on the server`);
      continue;
    }
    // A value import pulls in the target's whole module graph. A type import is
    // erased at compile time and carries nothing, so it may go wider.
    if (!typeOnly && !isPureSpecifier(spec, rel)) {
      problems.push(
        `${rel} has a value import of ${spec}. Make it a type import, or add the target to PURE_MODULES.`
      );
    }
  }
  return problems;
}

function readPure(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

test("the pure modules import nothing server-side", () => {
  for (const rel of PURE_MODULES) {
    assert.deepEqual(importViolations(rel, readPure(rel)), []);
  }

  // Not vacuous: the parser really does see the imports these files have.
  assert.deepEqual(importsOf(readPure("src/lib/assessment/ca.ts")), [
    { spec: "@/types/student-dashboard", typeOnly: true },
  ]);
  assert.deepEqual(importsOf(readPure("src/lib/auth/claims.ts")), [
    { spec: "@/types", typeOnly: true },
  ]);
  assert.ok(
    importsOf(readPure("src/lib/assessment/skips.ts")).some(
      (i) => i.spec === "./ca" && !i.typeOnly
    ),
    "expected skips.ts to import decideCaTarget as a value"
  );
});

test("the boundary rule rejects the imports it exists to reject", () => {
  const rel = "src/lib/assessment/skips.ts";
  const rejected = [
    'import "server-only";',
    'import { getFirestore } from "firebase-admin/firestore";',
    'import { adminDb } from "@/lib/firebase/admin";',
    // Type-only is no defence for these: the import is the signal that this
    // module has grown a server-side dependency, whatever it currently uses.
    'import type { Firestore } from "firebase-admin/firestore";',
    // A value import of a module that is not itself held to these rules, even
    // though it looks harmless: db/submissions reaches the Admin SDK.
    'import { submissionId } from "@/lib/db/submissions";',
    'import { headers } from "next/headers";',
    'import { adminDb } from "../firebase/admin";',
    // One value binding among the types is still a value import: the target's
    // whole module graph comes with it.
    'import { type SkipReason, formatBytes } from "@/lib/format";',
  ];
  for (const line of rejected) {
    assert.equal(
      importViolations(rel, line).length,
      1,
      `should have been rejected: ${line}`
    );
  }

  const allowed = [
    'import type { AssignmentSubmission } from "@/types/student-dashboard";',
    'import { decideCaTarget } from "./ca";',
    'import { GRADING_ATTEMPT_CAP } from "@/lib/assessment/grading-recovery";',
    'import { type CaSkipReason } from "./ca";',
    'export type { CaTarget } from "./ca";',
  ];
  for (const line of allowed) {
    assert.deepEqual(importViolations(rel, line), [], `should have been allowed: ${line}`);
  }
});

test("the pure assessment modules read no secret", () => {
  // grading-recovery reads GRADING_STALE_MINUTES, a tuning number, which is
  // fine. Anything that reads like a credential is not: these modules run under
  // `npm run test:offline` and must never be why a key is expected to exist.
  const secretish = /process\.env\.[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL)/;
  for (const rel of PURE_MODULES) {
    const hit = secretish.exec(readPure(rel));
    assert.equal(hit, null, `${rel} reads ${hit?.[0]}`);
  }
});

// ---------------------------------------------------------------------------
// Term and session audit: does a mark join, or does it drop out silently?
// ---------------------------------------------------------------------------

const jdRow = (term: unknown, session: unknown, source: JdRow["source"] = "assignments"): JdRow => ({
  term,
  session,
  source,
});
const rpRow = (term: unknown, session: unknown, source: RpRow["source"] = "exams"): RpRow => ({
  term,
  session,
  source,
});

test("a pair is matched only when both halves match byte for byte", () => {
  const rp = [rpRow("First Term", "2025/2026")];

  const exact = auditTermSessions([jdRow("First Term", "2025/2026")], rp);
  assert.equal(exact.rows[0]?.matched, true);
  assert.deepEqual(exact.rows[0]?.matchedIn, ["exams"]);
  assert.equal(exact.totals.unmatchedPairs, 0);

  // Each of these is a different result sheet in ResultPeak, so each is a
  // different pair here. Trimming any of them away would be the bug.
  const differing = [
    ["First Term ", "2025/2026", "trailing space on the term"],
    [" First Term", "2025/2026", "leading space on the term"],
    ["first term", "2025/2026", "lower case term"],
    ["First  Term", "2025/2026", "doubled inner space"],
    ["First\u00a0Term", "2025/2026", "non-breaking space in the term"],
    ["First Term", "2025/2026 ", "trailing space on the session"],
    ["First Term", "2025-2026", "a different separator in the session"],
  ] as const;

  for (const [term, session, why] of differing) {
    const report = auditTermSessions([jdRow(term, session)], rp);
    assert.equal(report.rows[0]?.matched, false, `should not have matched: ${why}`);
    assert.equal(report.totals.unmatchedRows, 1);
  }
});

test("an unmatched pair says what it nearly is, without that changing its status", () => {
  const report = auditTermSessions(
    [jdRow("First Term ", "2025/2026")],
    [rpRow("First Term", "2025/2026", "results")]
  );

  const row = report.rows[0];
  assert.equal(row?.matched, false, "a near miss is still a miss");
  assert.deepEqual(row?.matchedIn, []);
  assert.equal(row?.nearMisses.length, 1);
  assert.equal(row?.nearMisses[0]?.source, "results");
  assert.deepEqual(row?.nearMisses[0]?.differences, ["trailing whitespace on the term"]);

  // A genuinely different session is nobody's near miss.
  const unrelated = auditTermSessions(
    [jdRow("First Term", "2019/2020")],
    [rpRow("First Term", "2025/2026")]
  );
  assert.deepEqual(unrelated.rows[0]?.nearMisses, []);
});

test("invisible characters are rendered, and only for display", () => {
  assert.equal(visible("First\u00a0Term"), "First\\u00a0Term");
  assert.equal(visible("2025/2026\u200b"), "2025/2026\\u200b");
  assert.equal(visible("a\tb"), "a\\tb");
  assert.equal(visible("First Term"), "First Term", "an ordinary string is untouched");

  // The rendering reaches the report, so a difference nobody can see in a
  // terminal is still readable there.
  const report = auditTermSessions([jdRow("First\u00a0Term", "2025/2026")], []);
  assert.equal(report.rows[0]?.term, "First\\u00a0Term");
});

test("pair keys cannot collide across the term and session boundary", () => {
  // A joined key like `term + "|" + session` reports these two as the same pair,
  // which is the one wrong answer that matters: a mismatch shown as a match.
  assert.notEqual(pairKey("a|b", "c"), pairKey("a", "b|c"));
  assert.notEqual(pairKey('a"', "b"), pairKey("a", '"b'));
  assert.equal(pairKey("First Term", "2025/2026"), pairKey("First Term", "2025/2026"));
});

test("rows are counted per source, and the heaviest unmatched pair leads", () => {
  const report = auditTermSessions(
    [
      jdRow("Third Term", "2025/2026", "assignments"),
      jdRow("Third Term", "2025/2026", "submissions"),
      jdRow("Third Term", "2025/2026", "submissions"),
      jdRow("First Term", "2026/2027", "assignments"),
      jdRow("Second Term", "2025/2026", "assignments"),
    ],
    [rpRow("Third Term", "2025/2026")]
  );

  assert.equal(report.totals.rows, 5);
  assert.equal(report.totals.pairs, 3);
  assert.equal(report.totals.unmatchedPairs, 2);
  assert.equal(report.totals.unmatchedRows, 2);

  // Unmatched first. Both unmatched pairs carry one row, so they fall back to a
  // stable order rather than to whichever was read first: session before term,
  // because a reader is looking for two sessions that should have been one.
  assert.deepEqual(
    report.rows.map((r) => [r.term, r.session, r.matched]),
    [
      ["Second Term", "2025/2026", false],
      ["First Term", "2026/2027", false],
      ["Third Term", "2025/2026", true],
    ]
  );

  const matched = report.rows[2];
  assert.deepEqual(matched?.counts, { assignments: 1, submissions: 2 });
  assert.equal(matched?.total, 3);
});

test("a row with no usable term or session is a finding, not a skipped row", () => {
  const report = auditTermSessions(
    [
      jdRow(undefined, "2025/2026"),
      jdRow("First Term", null),
      jdRow("First Term", ""),
      jdRow(3, "2025/2026"),
    ],
    [rpRow("First Term", "2025/2026")]
  );

  assert.equal(report.rows.length, 0, "none of these can be compared as a pair");
  assert.equal(
    report.malformed.reduce((n, g) => n + g.total, 0),
    4,
    "and none of them may be dropped either"
  );
  const rendered = report.malformed.map((g) => `${g.term} / ${g.session}`);
  assert.ok(rendered.includes("(field absent) / 2025/2026"));
  assert.ok(rendered.includes("First Term / (null)"));
  assert.ok(rendered.includes("First Term / (empty string)"));
  assert.ok(rendered.includes("(number: 3) / 2025/2026"));
});

test("a term carried under two sessions is reported as a split", () => {
  const report = auditTermSessions(
    [],
    [
      rpRow("Third Term", "2025/2026", "exams"),
      rpRow("Third Term", "2026/2027", "results"),
      rpRow("Third Term", "2026/2027", "results"),
      rpRow("First Term", "2025/2026", "exams"),
    ]
  );

  assert.equal(report.splitTerms.length, 1);
  assert.equal(report.splitTerms[0]?.term, "Third Term");
  assert.deepEqual(report.splitTerms[0]?.sessions, [
    { session: "2026/2027", total: 2 },
    { session: "2025/2026", total: 1 },
  ]);

  // This is the shape the live project is in, and it is a finding even though
  // JDSmartLearn has no rows at all yet.
  assert.equal(report.totals.rows, 0);

  const lines = formatReport(report, "school-1").join("\n");
  assert.match(lines, /SPLIT TERM/);
  assert.match(lines, /"2026\/2027" \(2 row\(s\)\), "2025\/2026" \(1 row\(s\)\)/);
});

test("the school profile is a source of its own, and says so when it is the only one", () => {
  const report = auditTermSessions(
    [jdRow("First Term", "2026/2027")],
    [rpRow("First Term", "2026/2027", "school profile")]
  );

  assert.equal(report.rows[0]?.matched, true);
  const lines = formatReport(report, "school-1").join("\n");
  assert.match(lines, /only the school profile states this pair/);
  assert.match(lines, /No exam or result carries it yet/);
});

test("the report says what an operator has to do next", () => {
  const lines = formatReport(
    auditTermSessions([jdRow("First Term", "2026/2027")], [rpRow("Third Term", "2025/2026")]),
    "school-1"
  ).join("\n");

  assert.match(lines, /1 unmatched pair\(s\) covering 1 row\(s\)/);
  assert.match(lines, /UNMATCHED/);
  assert.match(lines, /no exam, result or school profile in this school carries this pair/);
  // Quoted, so a trailing space is visible at the end of the column.
  assert.match(lines, /"First Term" \/ "2026\/2027"/);
});

// ---------------------------------------------------------------------------
// The read-only handle, and the diagnostic that must keep using it
// ---------------------------------------------------------------------------

/** Enough of a Firestore to exercise the wrapper without a network or a project. */
function fakeFirestore() {
  const wrote: string[] = [];
  const docRef = (path: string) => ({
    path,
    get: async () => ({ exists: true, data: () => ({ term: "First Term" }) }),
    set: (v: unknown) => wrote.push(`set ${path} ${JSON.stringify(v)}`),
    update: () => wrote.push(`update ${path}`),
    delete: () => wrote.push(`delete ${path}`),
  });
  const collectionRef = (path: string) => ({
    path,
    doc: (id: string) => docRef(`${path}/${id}`),
    add: () => wrote.push(`add ${path}`),
    where: () => ({ limit: () => ({ get: async () => ({ size: 1, docs: [] }) }) }),
  });
  return {
    wrote,
    db: {
      collection: collectionRef,
      doc: docRef,
      batch: () => ({ commit: async () => wrote.push("batch commit") }),
      runTransaction: async () => wrote.push("transaction"),
    },
  };
}

test("a read-only handle still reads", async () => {
  const { db } = fakeFirestore();
  const readable = readOnlyDb(db);

  const snap = await readable.doc("schools/abc").get();
  assert.equal(snap.exists, true);
  assert.equal(snap.data().term, "First Term");

  const page = await readable.collection("assignments").where().limit().get();
  assert.equal(page.size, 1);

  // The path survives the wrapper, which is what puts a usable path in a refusal.
  assert.equal(readable.collection("assignments").path, "assignments");
});

test("a read-only handle refuses every write, and nothing reaches the fake", () => {
  const { db, wrote } = fakeFirestore();
  const readable = readOnlyDb(db);

  assert.throws(() => readable.doc("assignments/a1").set({ term: "x" }), /read-only/);
  assert.throws(() => readable.doc("assignments/a1").update(), /read-only/);
  assert.throws(() => readable.doc("assignments/a1").delete(), /read-only/);
  assert.throws(() => readable.collection("assignments").add(), /read-only/);
  // Reached through the collection rather than directly: the child reference is
  // wrapped too, which is the leak this would otherwise have.
  assert.throws(() => readable.collection("assignments").doc("a1").set({}), /read-only/);
  assert.throws(() => readable.batch(), /read-only/);
  assert.throws(() => readable.runTransaction(), /read-only/);

  assert.deepEqual(wrote, [], "not one write may reach the underlying handle");
});

test("a write to a ResultPeak collection is refused as theirs, not merely as read-only", () => {
  const { db } = fakeFirestore();
  const readable = readOnlyDb(db);

  // The ownership message comes first, because "this is somebody else's data" is
  // what a reader needs before "this handle happens to be read-only".
  assert.throws(() => readable.doc("results/r1").set({}), /ResultPeak owns this collection/);
  assert.throws(() => readable.collection("students").doc("s1").delete(), /ResultPeak owns/);
  assert.throws(() => readable.doc("schools/s1").update(), /ResultPeak owns/);

  // A JDSmartLearn path is refused as well. A diagnostic repairs nothing at all,
  // not even our own collections.
  assert.throws(() => readable.doc("assignments/a1").set({}), /diagnostic/);
});

/**
 * The diagnostic script must not grow a write, and it must keep asking for the
 * wrapped handle.
 *
 * A SECOND GUARD OVER THE SAME FILE, on purpose. `readOnlyDb` covers the handle;
 * it cannot cover a reference reached through a snapshot's `.ref`, and it covers
 * nothing at all if somebody calls `getFirestore()` again further down the file.
 * This scan covers both of those and costs one regex.
 */
const DIAGNOSTIC = "scripts/diagnose-term-session.ts";

/** Method calls that write. `add` catches a `Set` too, which is a fair price. */
const WRITE_CALL = /\.(set|update|delete|create|add|batch|bulkWriter|runTransaction|recursiveDelete)\s*\(/;

function diagnosticViolations(source: string): string[] {
  const problems: string[] = [];

  const write = WRITE_CALL.exec(source);
  if (write) {
    problems.push(
      `${DIAGNOSTIC} calls ${write[0]}, which writes. A diagnostic reports and repairs nothing.`
    );
  }
  /**
   * EVERY `getFirestore()` must be wrapped, counted rather than merely spotted.
   *
   * `source.includes("readOnlyDb(")` was the obvious check and it was useless:
   * the file's own doc comment names `readOnlyDb()`, so unwrapping the handle
   * left the check passing. Counting catches both the unwrap and the second,
   * unwrapped handle fetched further down the file.
   */
  const handles = source.match(/getFirestore\(\)/g)?.length ?? 0;
  const wrapped = source.match(/readOnlyDb\(getFirestore\(\)\)/g)?.length ?? 0;
  if (handles === 0 || handles !== wrapped) {
    problems.push(
      `${DIAGNOSTIC} has ${handles} getFirestore() call(s) and ${wrapped} wrapped in ` +
        `readOnlyDb(). Every handle it holds must be the read-only one.`
    );
  }
  if (source.includes("studentAcademicRecords")) {
    problems.push(
      `${DIAGNOSTIC} names the shared academic record. Only ResultPeak's own ` +
        `api/_lib/academicRecords.js may name that collection.`
    );
  }
  return problems;
}

test("the diagnostic writes nothing and keeps the read-only handle", () => {
  assert.deepEqual(diagnosticViolations(readPure(DIAGNOSTIC)), []);
});

test("the diagnostic scan rejects what it exists to reject", () => {
  const clean = readPure(DIAGNOSTIC);

  // Not vacuous: each of these is a real way this file could go wrong, and each
  // one has to be caught by the scan rather than by somebody reading the diff.
  assert.equal(diagnosticViolations(`${clean}\nawait db.doc("x/y").set({});`).length, 1);
  assert.equal(diagnosticViolations(`${clean}\nconst b = db.batch();`).length, 1);
  assert.equal(diagnosticViolations(`${clean}\nsnap.docs[0].ref.delete();`).length, 1);
  assert.equal(
    diagnosticViolations(clean.replace("readOnlyDb(getFirestore())", "getFirestore()")).length,
    1,
    "unwrapping the handle must fail even though the file still writes nothing"
  );
  assert.equal(
    diagnosticViolations(`${clean}\nconst raw = getFirestore();`).length,
    1,
    "a second, unwrapped handle must fail even though the first is still wrapped"
  );
  // Reading it is refused as well as writing it. The shared record is not this
  // diagnostic's business at all, and `.get()` on its own trips nothing.
  assert.equal(
    diagnosticViolations(`${clean}\nawait db.collection("studentAcademicRecords").get();`).length,
    1
  );
});

// ---------------------------------------------------------------------------
// Subject allocation: the (class, subject) scoping, and its legacy fallback
// ---------------------------------------------------------------------------

/**
 * The risk in this feature is not that a check is too loose. It is that a check
 * is too tight on a tutor ResultPeak has not allocated yet - most of them, for
 * a while - and locks a working account out on deploy. Nearly every case below
 * is about that direction.
 */

const ALLOCATED: SubjectAllocation = {
  isAdmin: false,
  assignedSubjects: ["mathematics", "further_mathematics"],
  subjectClasses: {
    mathematics: ["jss1a", "jss2a"],
    further_mathematics: ["ss1a"],
  },
};

const LEGACY: SubjectAllocation = {
  isAdmin: false,
  assignedSubjects: [],
  subjectClasses: {},
};

test("an unallocated tutor passes every subject check", () => {
  assert.equal(isUnallocated(LEGACY), true);
  assert.equal(teachesSubjectInClass(LEGACY, "jss1a", "mathematics"), true);
  assert.equal(teachesSubjectInClass(LEGACY, "ss3b", "civic_education"), true);
  assert.equal(teachesSubject(LEGACY, "anything_at_all"), true);
});

test("a half-derived profile still counts as unallocated", () => {
  // ResultPeak writes `assignments` first and derives the rest. A profile caught
  // between the two must fall back to today's behaviour, not fail every lookup
  // against an empty map. Both directions of the disagreement.
  const subjectsOnly: SubjectAllocation = {
    isAdmin: false,
    assignedSubjects: ["mathematics"],
    subjectClasses: {},
  };
  const mapOnly: SubjectAllocation = {
    isAdmin: false,
    assignedSubjects: [],
    subjectClasses: { mathematics: ["jss1a"] },
  };

  assert.equal(isUnallocated(subjectsOnly), true);
  assert.equal(isUnallocated(mapOnly), true);
  // The point of the fallback: no lockout on a subject the map does not mention.
  assert.equal(teachesSubjectInClass(subjectsOnly, "jss1a", "english"), true);
  assert.equal(teachesSubjectInClass(mapOnly, "jss9z", "english"), true);
});

test("an admin is unrestricted, as they are for assignedClasses", () => {
  const admin: SubjectAllocation = { ...ALLOCATED, isAdmin: true };
  assert.equal(teachesSubjectInClass(admin, "ss3b", "civic_education"), true);
  assert.equal(teachesSubject(admin, "civic_education"), true);
});

test("an allocated tutor is held to their own pairs", () => {
  assert.equal(isUnallocated(ALLOCATED), false);
  assert.equal(teachesSubjectInClass(ALLOCATED, "jss1a", "mathematics"), true);
  assert.equal(teachesSubjectInClass(ALLOCATED, "ss1a", "further_mathematics"), true);

  // Right subject, wrong class.
  assert.equal(teachesSubjectInClass(ALLOCATED, "ss1a", "mathematics"), false);
  // Right class, wrong subject - the case that used to expose a marking guide.
  assert.equal(teachesSubjectInClass(ALLOCATED, "jss1a", "english"), false);
  // Neither.
  assert.equal(teachesSubjectInClass(ALLOCATED, "ss3b", "english"), false);
});

test("teachesSubject ignores the class, for the topics route", () => {
  // POST /api/topics has no classId at all: a topic is (subject, level, term).
  assert.equal(teachesSubject(ALLOCATED, "mathematics"), true);
  assert.equal(teachesSubject(ALLOCATED, "further_mathematics"), true);
  assert.equal(teachesSubject(ALLOCATED, "english"), false);
});

test("teachableMap narrows to real subjects and held classes", () => {
  const map = teachableMap(
    ALLOCATED,
    ["mathematics", "further_mathematics", "english"],
    ["jss1a", "jss2a", "ss1a"]
  );
  assert.deepEqual(map, {
    mathematics: ["jss1a", "jss2a"],
    further_mathematics: ["ss1a"],
  });

  // A subject removed in ResultPeak drops out rather than offering a dead option.
  assert.deepEqual(teachableMap(ALLOCATED, ["mathematics"], ["jss1a", "jss2a", "ss1a"]), {
    mathematics: ["jss1a", "jss2a"],
  });

  // A class the tutor no longer holds drops out, and a subject left with no
  // usable class disappears entirely.
  assert.deepEqual(
    teachableMap(ALLOCATED, ["mathematics", "further_mathematics"], ["jss1a"]),
    { mathematics: ["jss1a"] }
  );
});

test("teachableMap returns the empty map for the no-restriction cases", () => {
  // Both callers read `{}` as "offer everything", so these two must not return
  // a partially-built map that a picker would treat as a restriction.
  assert.deepEqual(teachableMap(LEGACY, ["mathematics"], ["jss1a"]), {});
  assert.deepEqual(
    teachableMap({ ...ALLOCATED, isAdmin: true }, ["mathematics"], ["jss1a"]),
    {}
  );
});

test("the pickers narrow in both directions", () => {
  const map = { mathematics: ["jss1a", "jss2a"], further_mathematics: ["ss1a"] };
  const subjects = [
    { id: "mathematics" },
    { id: "further_mathematics" },
    { id: "english" },
  ];
  const classes = [{ id: "jss1a" }, { id: "jss2a" }, { id: "ss1a" }];

  // Given a class, only subjects taught in it.
  assert.deepEqual(subjectsForClass(map, subjects, "jss1a"), [{ id: "mathematics" }]);
  assert.deepEqual(subjectsForClass(map, subjects, "ss1a"), [
    { id: "further_mathematics" },
  ]);
  // Given a subject, only the classes it is taught to.
  assert.deepEqual(classesForSubject(map, classes, "mathematics"), [
    { id: "jss1a" },
    { id: "jss2a" },
  ]);

  // Nothing chosen yet: everything stays on offer in both directions.
  assert.deepEqual(subjectsForClass(map, subjects, ""), subjects);
  assert.deepEqual(classesForSubject(map, classes, ""), classes);

  // An empty map is no restriction, matching teachableMap's contract.
  assert.deepEqual(subjectsForClass({}, subjects, "jss1a"), subjects);
  assert.deepEqual(classesForSubject({}, classes, "mathematics"), classes);

  // A subject with no entry offers no classes - it is not a licence to pick any.
  assert.deepEqual(classesForSubject(map, classes, "english"), []);
});
