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
  > & { id: string; title: string; subjectName: string; assessmentTypeId?: string }
) {
  return {
    schoolId: a.schoolId,
    assignmentId: a.id,
    classId: a.classId,
    subjectId: a.subjectId,
    term: a.term,
    session: a.session,
    ...(a.assessmentTypeId ? { assessmentTypeId: a.assessmentTypeId } : {}),
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
  | "nothing_released"
  | "column_not_allowed";

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
  knownAssessmentTypeIds: string[],
  /**
   * The school's full column list. When given, the admin's column must also
   * pass isAdminColumnAllowed(), so a column chosen before that check existed
   * (the exam, say) stops being fed instead of being fed forever.
   */
  columns?: AdminColumnInfo[]
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
  if (columns) {
    const column = columns.find((c) => c.value === typeId);
    if (column && !isAdminColumnAllowed(column, columns)) {
      return {
        status: "skipped",
        reason: "column_not_allowed",
        detail: `mapped type "${typeId}" is an exam or system column`,
      };
    }
  }
  return { status: "ready", assessmentTypeId: typeId };
}

/**
 * The same decision for an assignment that chose its own column. It was
 * teacher-marked when the tutor chose it; re-checked at every sync because
 * ResultPeak may since have removed the column or relabelled it.
 */
export function decideAssignmentColumn(
  typeId: string,
  columns: AssessmentColumnFlags[]
): CaTarget {
  const column = columns.find((c) => c.value === typeId);
  if (!column) {
    return {
      status: "skipped",
      reason: "type_removed",
      detail: `assessment type "${typeId}" is no longer on the school record`,
    };
  }
  if (!isTeacherMarkedColumn(column)) {
    return {
      status: "skipped",
      reason: "column_not_allowed",
      detail: `assessment type "${typeId}" is no longer labelled teacher-marked`,
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
  column_not_allowed:
    "Marks are not reaching report cards. The column they were set to count towards is an exam or system column, which homework must never fill. A school admin needs to choose a coursework column in Assessment settings.",
};

// ---------------------------------------------------------------------------
// Per-assignment report-card columns
// ---------------------------------------------------------------------------

/** The flags this repo reads on a `schools/{id}.assessmentTypes[]` entry. */
export type AssessmentColumnFlags = {
  value: string;
  teacherMarked?: boolean;
  automated?: boolean;
  systemMarked?: boolean;
};

/**
 * May a tutor send an assignment's marks into this column?
 *
 * FAILS CLOSED. Only a column ResultPeak has EXPLICITLY marked
 * `teacherMarked: true` qualifies, and an `automated` or `systemMarked` flag
 * still refuses it. A column with no flags at all is refused: ResultPeak does
 * not write these flags yet, so treating "unlabelled" as "allowed" offered every
 * column, the exam included, and homework could land under an exam.
 *
 * The ONE test, used by the new-assignment page and by the create route, so the
 * list a tutor sees and the list the server accepts cannot drift apart.
 * Contract: docs/resultpeak-scheduled-assignment-boxes-prompt.md.
 */
export function isTeacherMarkedColumn(c: AssessmentColumnFlags): boolean {
  return c.teacherMarked === true && c.automated !== true && c.systemMarked !== true;
}

/** A column with the names an admin sees, for the name check below. */
export type AdminColumnInfo = AssessmentColumnFlags & { label?: string; name?: string };

/**
 * May the school admin choose this column as the one older assignments feed?
 *
 * Looser than isTeacherMarkedColumn ON PURPOSE, because the admin's column
 * already works for schools today. Requiring the label everywhere would stop
 * every school's marks at once, before ResultPeak has labelled anything.
 *
 *   - A column ResultPeak flags automated, system-marked or not teacher-marked
 *     is always refused.
 *   - A school where ResultPeak has labelled ANY column teacher-marked is
 *     strict: only a labelled column may be chosen.
 *   - A school with no labels yet: refuse a column whose value or name says
 *     "exam". THIS IS A STOPGAP, a guess from a name, and it is named as one.
 *     It stops applying by itself the moment ResultPeak labels the school,
 *     because the strict rule above takes over. The real fix is the labels:
 *     docs/resultpeak-scheduled-assignment-boxes-prompt.md.
 */
export function isAdminColumnAllowed(c: AdminColumnInfo, all: AssessmentColumnFlags[]): boolean {
  if (c.automated === true || c.systemMarked === true || c.teacherMarked === false) return false;
  if (all.some((x) => x.teacherMarked === true)) return c.teacherMarked === true;
  return ![c.value, c.label, c.name].some((t) => typeof t === "string" && /exam/i.test(t));
}

/**
 * The report-card column a finalised mark feeds: the assignment's own column
 * when it chose one, otherwise the column the school admin set for older
 * assignments (null when that is unset).
 */
export function caColumnOf(
  row: { assessmentTypeId?: string | null },
  adminColumn: string | null
): string | null {
  return row.assessmentTypeId || adminColumn || null;
}

/**
 * The finalised marks that make up ONE column's average.
 *
 * Grouped by the column each mark actually lands in, not by whether its
 * assignment named a column. An older assignment feeding the admin's column
 * "first_assessment" and a newer one that chose "first_assessment" write to the
 * SAME place on the report card, so they must be averaged together. Averaged
 * apart, each finalise overwrote the other and the child's mark flipped between
 * two numbers depending on which was marked last.
 */
export function marksForColumn<T extends { assessmentTypeId?: string | null }>(
  rows: T[],
  column: string | null,
  adminColumn: string | null
): T[] {
  return rows.filter((r) => caColumnOf(r, adminColumn) === column);
}

/**
 * Document id in `jdCaScores`: one per student, subject, session, term AND
 * column. The column joined the key when assignments began choosing their own.
 */
export function caScoreId(e: {
  schoolId: string;
  studentId: string;
  subjectId: string;
  session: string;
  term: string;
  assessmentTypeId: string;
}): string {
  return encodeURIComponent(
    [e.schoolId, e.studentId, e.subjectId, e.session, e.term, e.assessmentTypeId].join("_")
  );
}

/**
 * The id `jdCaScores` used before the column was part of the key. A document
 * still under this id holds the score for the column in its own
 * `assessmentTypeId` field until a write under the new id supersedes it.
 */
export function legacyCaScoreId(e: {
  schoolId: string;
  studentId: string;
  subjectId: string;
  session: string;
  term: string;
}): string {
  return encodeURIComponent([e.schoolId, e.studentId, e.subjectId, e.session, e.term].join("_"));
}
