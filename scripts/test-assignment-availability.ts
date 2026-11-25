import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isAssignmentVisibleToStudent, isAssignmentSubmittable } from "../src/lib/assignments/availability";

test("scheduled work is visible only inside the inclusive window", () => {
  const assignment = { isActive: true, opensAt: 100, closesAt: 200, dueDate: 190 };
  assert.equal(isAssignmentVisibleToStudent(assignment, 99), false);
  assert.equal(isAssignmentVisibleToStudent(assignment, 100), true);
  assert.equal(isAssignmentVisibleToStudent(assignment, 200), true);
  assert.equal(isAssignmentVisibleToStudent(assignment, 201), false);
  assert.equal(isAssignmentSubmittable(assignment, 99), false);
  assert.equal(isAssignmentSubmittable(assignment, 200), true);
  assert.equal(isAssignmentSubmittable(assignment, 201), false);
});

test("legacy active work remains visible and drafts stay hidden", () => {
  assert.equal(isAssignmentVisibleToStudent({ isActive: true }, 100), true);
  assert.equal(isAssignmentVisibleToStudent({ isActive: false }, 100), false);
});
