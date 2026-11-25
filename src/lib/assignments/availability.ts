import type { Assignment } from "@/types/student-dashboard";

/** Scheduling rules shared by every student-facing assignment path. */
export function assignmentWindowProblem(
  assignment: Pick<Assignment, "opensAt" | "closesAt">,
  now = Date.now()
): "not_yet_open" | "closed" | null {
  // Both fields absent is the legacy behaviour: available whenever active.
  if (typeof assignment.opensAt === "number" && now < assignment.opensAt) return "not_yet_open";
  if (typeof assignment.closesAt === "number" && now > assignment.closesAt) return "closed";
  return null;
}

export function isAssignmentVisibleToStudent(
  assignment: Pick<Assignment, "isActive" | "opensAt" | "closesAt">,
  now = Date.now()
) {
  return assignment.isActive && assignmentWindowProblem(assignment, now) === null;
}

export const SUBMISSION_GRACE_MS = 60 * 60 * 1000;

export function isAssignmentSubmittable(
  assignment: Pick<Assignment, "isActive" | "dueDate" | "opensAt" | "closesAt">,
  now = Date.now()
) {
  if (!isAssignmentVisibleToStudent(assignment, now)) return false;
  const graceCutoff = assignment.dueDate + SUBMISSION_GRACE_MS;
  const cutoff = typeof assignment.closesAt === "number"
    ? Math.min(graceCutoff, assignment.closesAt)
    : graceCutoff;
  return now <= cutoff;
}

export function assignmentAvailabilityMessage(
  assignment: Pick<Assignment, "opensAt" | "closesAt">,
  now = Date.now()
) {
  const problem = assignmentWindowProblem(assignment, now);
  if (problem === "not_yet_open") return "This assignment is not open yet.";
  if (problem === "closed") return "This assignment is no longer available.";
  return null;
}
