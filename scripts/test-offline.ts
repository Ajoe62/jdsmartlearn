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

import {
  batched,
  dayKey,
  evictionPlan,
  groupBySubject,
  planSync,
  type LocalLessonState,
} from "../src/lib/offline/merge";
import { collapse, isLocalId, type OutboxOp } from "../src/lib/offline/collapse";
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
