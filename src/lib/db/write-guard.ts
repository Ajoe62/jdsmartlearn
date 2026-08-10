import {
  LMS_WRITABLE_RECORD_FIELDS,
  RECORD_IDENTITY_FIELDS,
  RESULTPEAK_OWNED,
} from "./collections";

/**
 * Throws if code attempts to write to a ResultPeak-owned collection.
 * ResultPeak is live with a paying school; an accidental write here is a
 * production incident, not a bug.
 */
export function assertWritable(collectionPath: string): void {
  const root = collectionPath.split("/")[0];
  if (RESULTPEAK_OWNED.has(root)) {
    throw new Error(
      `Refusing to write to "${collectionPath}". ResultPeak owns this collection; ` +
        `JDSmartLearn is read-only here. See CLAUDE.md.`
    );
  }
}

const ALLOWED_RECORD_KEYS = new Set<string>([
  ...LMS_WRITABLE_RECORD_FIELDS,
  ...RECORD_IDENTITY_FIELDS,
]);

/**
 * Throws if a `studentAcademicRecords` write reaches beyond JDSmartLearn's half
 * of the document.
 *
 * That document is owned by neither platform. JDSmartLearn writes
 * `continuousAssessment` and `lastUpdatedByLMS`; ResultPeak writes `examScore`
 * and `lastUpdatedByAssessment`. There is no merge negotiation and no recovery:
 * one wrong key overwrites a paying school's exam marks.
 *
 * Dotted paths are checked at their root, so `continuousAssessment.maths` passes
 * and `examScore.maths` throws. Call this before every write, and always write
 * with merge - see `db/academic-records.ts`.
 */
export function assertRecordFields(update: Record<string, unknown>): void {
  const keys = Object.keys(update);
  if (keys.length === 0) {
    throw new Error("Refusing an empty studentAcademicRecords write.");
  }

  for (const key of keys) {
    const root = key.split(".")[0];
    if (!ALLOWED_RECORD_KEYS.has(root)) {
      throw new Error(
        `Refusing to write "${key}" on studentAcademicRecords. JDSmartLearn may ` +
          `write only ${LMS_WRITABLE_RECORD_FIELDS.join(", ")}; "${root}" belongs ` +
          `to ResultPeak. See CLAUDE.md, Assessment rules.`
      );
    }
  }

  /**
   * `continuousAssessment` is TWO levels deep: subjectId, then the assessment
   * type's stable id, then a percentage. The nesting is checked as well as the
   * top-level key, because `set(..., { merge: true })` deep-merges maps. A
   * malformed inner value would be merged in silently and then read back by
   * ResultPeak as a component score for a column that does not exist.
   */
  const ca = update.continuousAssessment;
  if (ca !== undefined) {
    if (typeof ca !== "object" || ca === null || Array.isArray(ca)) {
      throw new Error(
        "Refusing a continuousAssessment that is not a map of subjectId to assessment scores."
      );
    }
    for (const [subjectId, byType] of Object.entries(ca as Record<string, unknown>)) {
      if (typeof byType !== "object" || byType === null || Array.isArray(byType)) {
        throw new Error(
          `Refusing continuousAssessment["${subjectId}"]: expected a map of ` +
            `assessment type to percentage, which is how ResultPeak models CA. ` +
            `A single number per subject cannot be placed in any of its columns.`
        );
      }
      for (const [typeId, value] of Object.entries(byType as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(
            `Refusing continuousAssessment["${subjectId}"]["${typeId}"]: not a number.`
          );
        }
        // Percentages, never raw marks. ResultPeak scales by its own maxScore.
        if (value < 0 || value > 100) {
          throw new Error(
            `Refusing continuousAssessment["${subjectId}"]["${typeId}"] = ${value}. ` +
              `Values are percentages from 0 to 100; ResultPeak scales them by the ` +
              `assessment type's maxScore.`
          );
        }
      }
    }
  }
}
