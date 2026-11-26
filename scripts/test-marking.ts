/**
 * The release race and the report-card send. Run: npm run test:marking
 *
 * Pure rules first (lib/assessment/marking.ts), then source checks that keep a
 * blind write from coming back into the AI marking path. See the header of
 * marking.ts for the bug these protect against.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ALREADY_RELEASED_TEXT,
  STALE_MARK_TEXT,
  aiMayWrite,
  caNeedsResend,
  decideMarkingWrite,
  mayClaimAttempt,
  type MarkingCurrent,
} from "../src/lib/assessment/marking";

const NOW = 1_800_000_000_000;

function current(over: Partial<MarkingCurrent> = {}): MarkingCurrent {
  return { status: "ai_graded", aiScore: 7, finalScore: null, updatedAt: 100, ...over };
}

// ---------------------------------------------------------------------------
// The AI side may write only while the work is waiting
// ---------------------------------------------------------------------------

test("AI may write only to work still waiting for marking", () => {
  assert.equal(aiMayWrite("submitted"), true);
  assert.equal(aiMayWrite("ai_grading"), true);
  for (const s of ["ai_graded", "ai_grading_failed", "teacher_reviewed", "finalised", undefined, ""]) {
    assert.equal(aiMayWrite(s), false, `must not write over ${s}`);
  }
});

test("a released mark is never overwritten by a late AI result", () => {
  // The race: the sweep read "ai_grading", the tutor released, the AI finished.
  assert.equal(aiMayWrite("finalised"), false);
});

test("an attempt is claimed only once, and never after the tutor has marked", () => {
  assert.equal(mayClaimAttempt({ status: "ai_grading", gradingAttempts: 1 }, 1), true);
  // A second sweep read the same row: the first already moved the count.
  assert.equal(mayClaimAttempt({ status: "ai_grading", gradingAttempts: 2 }, 1), false);
  // The tutor released it between the sweep's read and its claim.
  assert.equal(mayClaimAttempt({ status: "finalised", gradingAttempts: 1 }, 1), false);
  // Documents from before the count existed read as 0.
  assert.equal(mayClaimAttempt({ status: "submitted" }, 0), true);
});

// ---------------------------------------------------------------------------
// The tutor's request, decided on the copy the transaction read
// ---------------------------------------------------------------------------

test("releasing uses the tutor's mark, else the AI mark read in the transaction", () => {
  const withTutor = decideMarkingWrite(
    current(),
    { action: "finalise", teacherScore: 9, teacherComment: "Good", baseUpdatedAt: 100 },
    NOW
  );
  assert.equal(withTutor.kind, "write");
  if (withTutor.kind === "write") {
    assert.equal(withTutor.releases, true);
    assert.equal(withTutor.patch.status, "finalised");
    assert.equal(withTutor.patch.finalScore, 9);
    assert.equal(withTutor.patch.finalisedAt, NOW);
  }

  const withAi = decideMarkingWrite(
    current({ aiScore: 6 }),
    { action: "finalise", teacherScore: null, teacherComment: null, baseUpdatedAt: 100 },
    NOW
  );
  assert.equal(withAi.kind === "write" && withAi.patch.finalScore, 6);
});

test("releasing with no mark at all is refused", () => {
  const d = decideMarkingWrite(
    current({ status: "ai_grading", aiScore: null }),
    { action: "finalise", teacherScore: null, teacherComment: null, baseUpdatedAt: 100 },
    NOW
  );
  assert.equal(d.kind, "refuse");
  assert.equal(d.kind === "refuse" && d.status, 400);
});

test("a tutor may release while the AI is still marking; the tutor wins", () => {
  const d = decideMarkingWrite(
    current({ status: "ai_grading", aiScore: null }),
    { action: "finalise", teacherScore: 8, teacherComment: null, baseUpdatedAt: 100 },
    NOW
  );
  assert.equal(d.kind === "write" && d.patch.status, "finalised");
});

test("a stale version is refused with the 409 the offline queue expects", () => {
  const d = decideMarkingWrite(
    current({ updatedAt: 200 }),
    { action: "finalise", teacherScore: 9, teacherComment: null, baseUpdatedAt: 100 },
    NOW
  );
  assert.deepEqual(d, { kind: "refuse", status: 409, error: STALE_MARK_TEXT });
});

test("a draft can never un-release a mark", () => {
  const d = decideMarkingWrite(
    current({ status: "finalised", finalScore: 9, updatedAt: 100 }),
    { action: "draft", teacherScore: 3, teacherComment: null, baseUpdatedAt: 100 },
    NOW
  );
  assert.deepEqual(d, { kind: "refuse", status: 409, error: ALREADY_RELEASED_TEXT });
});

test("a released mark cannot be changed to a different number", () => {
  const d = decideMarkingWrite(
    current({ status: "finalised", finalScore: 9 }),
    { action: "finalise", teacherScore: 4, teacherComment: null },
    NOW
  );
  assert.equal(d.kind, "refuse");
});

test("replaying the same release is success that changes nothing", () => {
  // An offline release whose reply was lost: the replay carries the OLD version,
  // so it must be recognised before the version check rejects it.
  for (const teacherScore of [9, null]) {
    const d = decideMarkingWrite(
      current({ status: "finalised", finalScore: 9, updatedAt: 999 }),
      { action: "finalise", teacherScore, teacherComment: null, baseUpdatedAt: 100 },
      NOW
    );
    assert.deepEqual(d, { kind: "already_released", finalScore: 9 });
  }
});

test("a draft keeps the mark hidden", () => {
  const d = decideMarkingWrite(
    current(),
    { action: "draft", teacherScore: 5, teacherComment: "x", baseUpdatedAt: 100 },
    NOW
  );
  assert.equal(d.kind === "write" && d.releases, false);
  assert.equal(d.kind === "write" && d.patch.status, "teacher_reviewed");
  assert.equal(d.kind === "write" && d.patch.finalScore, undefined);
});

// ---------------------------------------------------------------------------
// "Send to report card again"
// ---------------------------------------------------------------------------

test("a failed or skipped send is offered again; a written one is not", () => {
  assert.equal(caNeedsResend({ status: "failed", at: 1 }), true);
  assert.equal(caNeedsResend({ status: "skipped", reason: "mapping_unset", at: 1 }), true);
  assert.equal(caNeedsResend({ status: "skipped", reason: "type_removed", at: 1 }), true);
  assert.equal(caNeedsResend({ status: "skipped", reason: "column_not_allowed", at: 1 }), true);
  assert.equal(caNeedsResend({ status: "skipped", reason: "nothing_released", at: 1 }), false);
  assert.equal(caNeedsResend({ status: "written", percentage: 80, at: 1 }), false);
  // Released before the record existed: unknown, never guessed.
  assert.equal(caNeedsResend(null), false);
  assert.equal(caNeedsResend(undefined), false);
});

// ---------------------------------------------------------------------------
// Source checks: no blind write may come back
// ---------------------------------------------------------------------------

const src = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
/** The code without comments, so a comment describing the old bug cannot trip a check. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("the AI marking route writes only through the conditional helper", () => {
  const route = code("src/app/api/ai/grade-assignment/route.ts");
  assert.doesNotMatch(route, /\bupdateSubmission\s*\(/, "blind updateSubmission in grading route");
  assert.doesNotMatch(route, /\.update\s*\(/, "direct .update() in grading route");
  assert.match(route, /updateSubmissionWhen\s*\(/);
});

test("the sweep never writes a submission outside a transaction", () => {
  const sweep = code("src/lib/db/grading-sweep.ts");
  assert.doesNotMatch(sweep, /adminDb\s*\.doc\([^)]*\)\s*\.update\s*\(/, "blind update in sweep");
  assert.doesNotMatch(sweep, /\bupdateSubmission\s*\(/, "blind updateSubmission in sweep");
});

test("the release route writes the mark inside a transaction and records the report-card outcome", () => {
  const route = code("src/app/api/tutor/finalise-assignment/route.ts");
  assert.match(route, /runTransaction/);
  assert.match(route, /decideMarkingWrite/);
  assert.match(route, /sendMarkToReportCard/);
  assert.doesNotMatch(route, /\bupdateSubmission\s*\(/, "blind updateSubmission in release route");
  // The send is never called bare: it lives in ca-sync, which never throws.
  assert.doesNotMatch(route, /\bsyncContinuousAssessment\s*\(/);
});

test("the report-card send records every outcome and cannot throw", () => {
  const sync = code("src/lib/db/ca-sync.ts");
  assert.match(sync, /recordCaSync/);
  assert.match(sync, /assignment\.ca\.failed/);
  assert.match(sync, /assignment\.ca\.skipped/);
});

test("the student projection never carries the report-card record", () => {
  const projection = code("src/lib/assessment/projection.ts");
  assert.doesNotMatch(projection, /caSync/);
});
