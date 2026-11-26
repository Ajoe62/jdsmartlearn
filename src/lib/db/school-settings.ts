import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP } from "./collections";
import { assertWritable } from "./write-guard";
import { resolveSchoolCalendar } from "@/lib/academic-calendar";
import type { AcademicSession, AcademicTerm } from "@/lib/academic-calendar";

/**
 * The current term and session, and the admin's report-card column.
 *
 * TERM AND SESSION ARE RESULTPEAK'S, AND SINCE 2026-11-26 THEY ARE READ FROM
 * RESULTPEAK. Its School profile saves `schools/{id}.currentTerm` and
 * `.currentSession`, and its copy of LMS marks onto report cards files by those
 * same two fields. Until then this repo held its own copy in `jdSchoolSettings`,
 * and that copy had drifted: on 2026-11-26 CAPSTONE's was a whole session behind
 * and Mt Cedar's a term ahead. A mark stamped from a stale copy here is filed
 * under the wrong term over there, so this repo no longer reads or writes its
 * own term at all. The old `term` and `session` fields are left on the settings
 * documents untouched and unread.
 *
 * `jdSchoolSettings` keeps only `lmsAssessmentType`, which is JDSmartLearn's.
 */

export interface SchoolSettings {
  schoolId: string;
  /** Verbatim from `schools/{id}.currentTerm`. Never normalised. */
  term: AcademicTerm;
  /** Verbatim from `schools/{id}.currentSession`. Never normalised. */
  session: AcademicSession;
  /**
   * The sessions new work may be set in: the current one only. Kept as a list
   * so the assignment form and route keep one shape.
   */
  knownSessions: AcademicSession[];
}

/** The admin's report-card column. JDSmartLearn's own setting. */
export interface ColumnSetting {
  /**
   * Which of the school's `assessmentTypes` the LMS feeds, by its stable `value`.
   *
   * NO DEFAULT, and never falls back. Some schools have no assignment-shaped
   * type at all: CAPSTONE ACADEMY has only first_assessment, second_assessment
   * and exam. Substituting would file a child's coursework under a column they
   * never sat, which is the exact failure ResultPeak's own `matchAssessmentType`
   * refuses. While this is null, CA sync does not run and the tutor is told so.
   */
  lmsAssessmentType: string | null;
}

/**
 * THE ONLY read of the current term and session, from ResultPeak's School
 * profile through `resolveSchoolCalendar()`.
 *
 * Returns null when the school has not set both, which is a real state with its
 * own interface copy, not an error and not a reason to guess. There is no
 * fallback to an older copy of ours: that copy is what was wrong.
 */
export async function getCurrentTermSession(
  schoolId: string
): Promise<SchoolSettings | null> {
  const snap = await adminDb.doc(`${RP.schools}/${schoolId}`).get();
  const calendar = resolveSchoolCalendar(snap.exists ? snap.data() : null);
  if (!calendar) return null;
  return { schoolId, ...calendar, knownSessions: [calendar.session] };
}

/** THE ONLY read of the admin's column. Unset reads as null, never a default. */
export async function getColumnSetting(schoolId: string): Promise<ColumnSetting> {
  const snap = await adminDb.doc(`${JD.schoolSettings}/${schoolId}`).get();
  const value = snap.exists ? snap.get("lmsAssessmentType") : null;
  return { lmsAssessmentType: typeof value === "string" && value !== "" ? value : null };
}

/** Saves the admin's column. Merge, so the retired term fields are left alone. */
export async function saveColumnSetting(
  schoolId: string,
  patch: ColumnSetting & { updatedBy: string }
): Promise<void> {
  assertWritable(JD.schoolSettings);
  await adminDb
    .doc(`${JD.schoolSettings}/${schoolId}`)
    .set({ schoolId, ...patch, updatedAt: Date.now() }, { merge: true });
}
