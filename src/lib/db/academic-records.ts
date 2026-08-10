import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, SHARED } from "./collections";
import { assertRecordFields, assertWritable } from "./write-guard";
import { getCurrentTermSession } from "./school-settings";
import { getSchool } from "./resultpeak";
import { decideCaTarget } from "@/lib/assessment/ca";
import type { CaTarget } from "@/lib/assessment/ca";
import type { StudentAcademicRecord } from "@/types/student-dashboard";

/** Re-exported so route handlers and pages keep one import for the CA contract. */
export { CA_SKIP_TEXT, decideCaTarget } from "@/lib/assessment/ca";
export type { CaSkipReason } from "@/lib/assessment/ca";
export type { CaTarget };

/**
 * The one document JDSmartLearn and ResultPeak both write.
 *
 * THE ENTIRE CONTRACT IS FIELD OWNERSHIP:
 *
 *   JDSmartLearn writes ONLY  continuousAssessment.{subjectId}.{assessmentTypeId}
 *                             lastUpdatedByLMS
 *   ResultPeak    writes ONLY  examScore.{subjectId}
 *                             lastUpdatedByAssessment
 *
 * continuousAssessment is TWO levels deep, and its values are PERCENTAGES from
 * 0 to 100, never raw marks. ResultPeak models CA as several named components
 * per subject, chosen per school, each with its own maxScore, so one number per
 * subject could not be placed in any of its columns. ResultPeak scales the
 * percentage on its side.
 *
 * Neither platform owns the document, so neither may write it wholesale. Every
 * write from this repo goes through writeContinuousAssessment() below, which
 * calls assertRecordFields() and always merges. There is no other writer here,
 * and there must not be: a set() without merge from either side destroys the
 * other's marks with no recovery path, because the source data lives in two
 * different products.
 *
 * ResultPeak needs the mirror-image guard before it writes here. Until it ships,
 * this contract is enforced on one side only.
 * See docs/firestore-rules-to-append.md.
 */

export function recordId(schoolId: string, studentId: string): string {
  return `${schoolId}_${studentId}`;
}

/**
 * The result of one CA sync. A skip carries its reason so the caller can log it
 * and the tutor page can explain itself in plain words.
 */
export type CaSyncOutcome =
  | { status: "written"; assessmentTypeId: string; percentage: number }
  | Extract<CaTarget, { status: "skipped" }>;

/**
 * Read the whole record, ResultPeak's half included.
 *
 * Reading their fields is fine and is what the progress page does. Writing them
 * is what is forbidden.
 */
export async function getAcademicRecord(
  schoolId: string,
  studentId: string
): Promise<StudentAcademicRecord | null> {
  const snap = await adminDb
    .doc(`${SHARED.studentAcademicRecords}/${recordId(schoolId, studentId)}`)
    .get();
  if (!snap.exists) return null;

  const data = snap.data() ?? {};
  return {
    id: snap.id,
    schoolId,
    studentId,
    continuousAssessment: (data.continuousAssessment ?? {}) as Record<
      string,
      Record<string, number>
    >,
    lastUpdatedByLMS: (data.lastUpdatedByLMS ?? null) as number | null,
    examScore: (data.examScore ?? {}) as Record<string, number>,
    lastUpdatedByAssessment: (data.lastUpdatedByAssessment ?? null) as number | null,
  };
}

/**
 * Sync one subject's continuous assessment score to ResultPeak.
 *
 * THE ONLY write to this collection in this codebase.
 *
 * Three deliberate choices, each load-bearing:
 *
 *  1. **A nested map plus `merge: true`**, not a dotted path. `set()` treats a
 *     key literally, so `{"continuousAssessment.maths": 80}` would create a
 *     field whose NAME contains a dot; only `update()` reads dots as paths. With
 *     merge, Firestore deep-merges map values, so writing Maths leaves English
 *     untouched. That is the behaviour we want, and this is the syntax that
 *     actually gets it.
 *  2. **`set` with merge**, never `update`, so the first write for a student
 *     creates the document instead of failing on a missing document, and never
 *     `set` without merge, which would delete `examScore`.
 *  3. **assertRecordFields() first**, so a future caller that adds a field to
 *     this object throws at runtime rather than silently reaching across the
 *     contract. It checks dotted paths at their root too, which covers any
 *     `update()` a later change might introduce.
 */
export async function writeContinuousAssessment(
  schoolId: string,
  studentId: string,
  subjectId: string,
  assessmentTypeId: string,
  percentage: number
): Promise<void> {
  for (const [name, value] of [
    ["subjectId", subjectId],
    ["assessmentTypeId", assessmentTypeId],
  ] as const) {
    if (!value || value.includes(".")) {
      // A dot would make this a path segment under any future update() call.
      throw new Error(`Refusing a ${name} that is not a single field key: "${value}"`);
    }
  }

  const rounded = Math.max(0, Math.min(100, Math.round(percentage)));

  const update: Record<string, unknown> = {
    schoolId,
    studentId,
    continuousAssessment: { [subjectId]: { [assessmentTypeId]: rounded } },
    lastUpdatedByLMS: Date.now(),
  };

  assertRecordFields(update);

  await adminDb
    .doc(`${SHARED.studentAcademicRecords}/${recordId(schoolId, studentId)}`)
    .set(update, { merge: true });
}

/**
 * THE ONLY path from a released mark to ResultPeak.
 *
 * Order matters and is deliberate:
 *
 *   1. resolve the school's mapped assessment type, or SKIP
 *   2. confirm it still exists on the school record, or SKIP
 *   3. write JDSmartLearn's own copy (the replay source)
 *   4. write the shared document
 *
 * Step 3 before step 4 so a CA score always exists somewhere we control, even if
 * the shared write fails or is later wiped by an unguarded write from the other
 * platform.
 *
 * A skip is a returned outcome, never a thrown error and never a silent no-op.
 * The caller logs it and the tutor page says so in plain words.
 */
export async function syncContinuousAssessment(entry: {
  schoolId: string;
  studentId: string;
  subjectId: string;
  session: string;
  term: string;
  percentage: number;
  submissionCount: number;
}): Promise<CaSyncOutcome> {
  const settings = await getCurrentTermSession(entry.schoolId);

  /**
   * Re-check against the school document every time, not against the setting
   * alone. ResultPeak lets an admin drop an assessment type after scores exist:
   * their editor warns with a confirmation but does not prevent it, and orphaned
   * scores are then filtered out of the result sheet entirely. So a mapping that
   * was valid last term can be pointing at nothing today.
   */
  const school = await getSchool(entry.schoolId);
  const types = (school as { assessmentTypes?: { value: string }[] } | null)
    ?.assessmentTypes;
  const known = Array.isArray(types) ? types.map((t) => t.value) : [];

  const target = decideCaTarget(settings, known);
  if (target.status === "skipped") return target;
  const typeId = target.assessmentTypeId;

  // Our copy first. See recordCaScore below.
  await recordCaScore({ ...entry, assessmentTypeId: typeId });

  await writeContinuousAssessment(
    entry.schoolId,
    entry.studentId,
    entry.subjectId,
    typeId,
    entry.percentage
  );

  return {
    status: "written",
    assessmentTypeId: typeId,
    percentage: Math.max(0, Math.min(100, Math.round(entry.percentage))),
  };
}

/**
 * JDSmartLearn's own copy of every CA score it has calculated.
 *
 * Written BEFORE the shared document, on purpose. `studentAcademicRecords` is
 * owned by neither platform and enforced on one side only until ResultPeak ships
 * its mirror guard, so a single `set()` without merge from over there would
 * destroy every school's CA with no way to rebuild it. This collection is that
 * way: one document per student, subject, session and term, replayable straight
 * back into the shared record.
 *
 * Deterministic id, `set` with merge, so a re-finalisation overwrites rather than
 * accumulating. That property matters more than it looks: ResultPeak's own
 * `manualScores` SUMS repeated writes, and a resync there would inflate a child's
 * total. See the handoff requirement in docs/firestore-rules-to-append.md.
 */
export async function recordCaScore(entry: {
  schoolId: string;
  studentId: string;
  subjectId: string;
  session: string;
  term: string;
  assessmentTypeId: string;
  percentage: number;
  /** How many finalised submissions the percentage was averaged from. */
  submissionCount: number;
}): Promise<void> {
  assertWritable(JD.caScores);
  const id = [
    entry.schoolId,
    entry.studentId,
    entry.subjectId,
    entry.session,
    entry.term,
  ].join("_");
  await adminDb
    .doc(`${JD.caScores}/${encodeURIComponent(id)}`)
    .set({ ...entry, updatedAt: Date.now() }, { merge: true });
}
