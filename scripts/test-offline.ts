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
import {
  DEFAULT_ALLOWED_FILE_TYPES,
  SUBMITTABLE_TYPES,
  resolveAllowedFileTypes,
} from "../src/lib/storage/file-types";
import type { SyncIndexEntry } from "../src/types";

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
// Module boundary: the pure assessment modules stay pure
// ---------------------------------------------------------------------------

/**
 * These modules are deliberately NOT marked `server-only`, so this file can
 * exercise the real rules that decide a child's mark rather than a copy of them.
 * That freedom is what this test pays for: nothing in them may reach the Admin
 * SDK, a secret, or a module that does.
 *
 * Add a module here when you add one to the folder.
 */
const PURE_MODULES = [
  "src/lib/assessment/ca.ts",
  "src/lib/assessment/grading-recovery.ts",
  "src/lib/assessment/skips.ts",
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

test("the pure assessment modules import nothing server-side", () => {
  for (const rel of PURE_MODULES) {
    assert.deepEqual(importViolations(rel, readPure(rel)), []);
  }

  // Not vacuous: the parser really does see the imports these files have.
  assert.deepEqual(importsOf(readPure("src/lib/assessment/ca.ts")), [
    { spec: "@/types/student-dashboard", typeOnly: true },
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
