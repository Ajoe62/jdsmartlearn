/**
 * Continuous assessment arithmetic and the CA sync decision.
 *
 * PURE. No Firestore, no server-only import, no `next/*`. That is deliberate:
 * these are the rules that decide what number reaches a child's report card and
 * which column it lands in, so they must be directly testable rather than
 * reachable only through a route handler.
 *
 * `src/lib/db/submissions.ts` and `src/lib/db/academic-records.ts` re-export and
 * call these; nothing duplicates them.
 */

import type { AssignmentSubmission } from "@/types/student-dashboard";

/** Percentage across finalised marks, or null when nothing has been released. */
export function averagePercentage(
  subs: Pick<AssignmentSubmission, "finalScore" | "maxMarks">[]
): number | null {
  const scored = subs.filter(
    (s): s is { finalScore: number; maxMarks: number } =>
      s.finalScore !== null && s.maxMarks > 0
  );
  if (scored.length === 0) return null;
  const total = scored.reduce((sum, s) => sum + s.finalScore / s.maxMarks, 0);
  return Math.round((total / scored.length) * 100);
}

/**
 * Assignment fields a submission denormalizes.
 *
 * ONE place, so the tutor table, the student list, the security rules and the CA
 * query cannot drift out of step. Every field here is required by something
 * downstream; none is decoration.
 *
 * `term` and `session` are copied from the ASSIGNMENT, never from the current
 * school setting. The setting moves through the year; a submission belongs to
 * the term its assignment was set in, permanently.
 */
export function denormalizedFrom(
  a: Pick<
    AssignmentSubmission,
    "schoolId" | "classId" | "subjectId" | "term" | "session" | "tutorId" | "maxMarks"
  > & { id: string; title: string; subjectName: string }
) {
  return {
    schoolId: a.schoolId,
    assignmentId: a.id,
    classId: a.classId,
    subjectId: a.subjectId,
    term: a.term,
    session: a.session,
    tutorId: a.tutorId,
    assignmentTitle: a.title,
    subjectName: a.subjectName,
    maxMarks: a.maxMarks,
  };
}

/** Why a CA sync did not happen. Never a silent no-op, never a guess. */
export type CaSkipReason =
  | "mapping_unset"
  | "type_removed"
  | "no_settings"
  | "nothing_released";

export type CaTarget =
  | { status: "ready"; assessmentTypeId: string }
  | { status: "skipped"; reason: CaSkipReason; detail: string };

/**
 * Which assessment type a released mark should feed, or why it must not be fed
 * at all.
 *
 * NO DEFAULT AND NO FALLBACK. If nothing is mapped, or the mapped type is no
 * longer on the school record, this returns a skip. It never picks another type.
 *
 * That is not caution for its own sake. Some schools have no coursework column:
 * CAPSTONE ACADEMY runs only first_assessment, second_assessment and exam, so a
 * fallback would file a child's homework under a test they never sat.
 * ResultPeak's own `matchAssessmentType()` refuses the same substitution, with
 * the same reasoning written in its comment.
 *
 * The school's list is re-checked on every sync rather than trusted from the
 * setting, because ResultPeak lets an admin drop an assessment type after scores
 * exist: its editor warns with a confirmation but does not prevent it.
 */
export function decideCaTarget(
  settings: { lmsAssessmentType: string | null } | null,
  knownAssessmentTypeIds: string[]
): CaTarget {
  if (!settings) {
    return { status: "skipped", reason: "no_settings", detail: "no school settings" };
  }
  const typeId = settings.lmsAssessmentType;
  if (!typeId) {
    return {
      status: "skipped",
      reason: "mapping_unset",
      detail: "no assessment type mapped",
    };
  }
  if (!knownAssessmentTypeIds.includes(typeId)) {
    return {
      status: "skipped",
      reason: "type_removed",
      detail: `mapped type "${typeId}" is no longer on the school record`,
    };
  }
  return { status: "ready", assessmentTypeId: typeId };
}

/** Plain text for a tutor. No system nouns, and it says what to do next. */
export const CA_SKIP_TEXT: Record<CaSkipReason, string> = {
  mapping_unset:
    "Marks are not being sent to report cards yet. A school admin needs to choose which column they count towards in Assessment settings.",
  type_removed:
    "Marks are not reaching report cards. The column they were set to count towards no longer exists in ResultPeak. A school admin needs to pick a new one.",
  no_settings:
    "Marks are not being sent to report cards yet. A school admin needs to set the current term and session.",
  nothing_released:
    "No marks have been released yet, so nothing has been sent to report cards.",
};
