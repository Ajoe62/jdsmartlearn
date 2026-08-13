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

/**
 * AN ALLOWLIST, AND IT MUST STAY ONE.
 *
 * This names what JDSmartLearn owns and refuses everything else by default. It
 * deliberately does NOT enumerate ResultPeak's fields, and must never be
 * rewritten to. A guard that lists the other platform's fields goes stale the
 * moment that platform adds one, and it fails OPEN when it does: a new field
 * over there would be writable from here until someone remembered to add it.
 *
 * That failure mode is not hypothetical. ResultPeak's own rules comment claims
 * four owned fields (examScore, combinedScore, grade, lastUpdatedByAssessment)
 * where this repo's docs claim two, and nobody noticed the two lists had drifted
 * apart. This guard was unaffected precisely because it never read either list.
 */
const ALLOWED_RECORD_KEYS = new Set<string>([
  ...LMS_WRITABLE_RECORD_FIELDS,
  ...RECORD_IDENTITY_FIELDS,
]);

/**
 * How many levels each writable field has BELOW its own key.
 *
 * `continuousAssessment` is subjectId, then the assessment type's stable id,
 * then a percentage: two levels. Everything else is a scalar: zero. This is what
 * lets one check cover a top-level key, a dotted path and a nested map, since a
 * dotted path is just some of the levels spent in the key instead of the value.
 */
const RECORD_FIELD_DEPTH: Record<string, number> = {
  continuousAssessment: 2,
  lastUpdatedByLMS: 0,
  schoolId: 0,
  studentId: 0,
};

/**
 * Validate a continuousAssessment value sitting `remaining` levels above a leaf.
 *
 * `remaining` falls as the key gets more specific, so all three write shapes
 * land in the same checks:
 *
 *   { continuousAssessment: { bio: { ca1: 72 } } }   remaining 2
 *   { "continuousAssessment.bio": { ca1: 72 } }      remaining 1
 *   { "continuousAssessment.bio.ca1": 72 }           remaining 0
 */
function assertCaValue(label: string, value: unknown, remaining: number): void {
  if (remaining === 0) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Refusing ${label}: not a number.`);
    }
    // Percentages, never raw marks. ResultPeak scales by its own maxScore.
    if (value < 0 || value > 100) {
      throw new Error(
        `Refusing ${label} = ${value}. Values are percentages from 0 to 100; ` +
          `ResultPeak scales them by the assessment type's maxScore.`
      );
    }
    return;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (remaining === 1) {
      throw new Error(
        `Refusing ${label}: expected a map of assessment type to percentage, ` +
          `which is how ResultPeak models CA. A single number per subject cannot ` +
          `be placed in any of its columns.`
      );
    }
    throw new Error(
      `Refusing a continuousAssessment that is not a map of subjectId to assessment scores.`
    );
  }

  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    assertCaValue(`${label}["${key}"]`, inner, remaining - 1);
  }
}

/**
 * Throws if a `studentAcademicRecords` write reaches beyond JDSmartLearn's half
 * of the document.
 *
 * That document is owned by neither platform. JDSmartLearn writes
 * `continuousAssessment` and `lastUpdatedByLMS` AND NOTHING ELSE; every other
 * field root is refused by default, whoever it belongs to. There is no merge
 * negotiation and no recovery: one wrong key overwrites a paying school's exam
 * marks, and the source data for the two halves lives in two different products.
 *
 * THE REFUSAL HOLDS AT EVERY DEPTH, because `set(..., { merge: true })`
 * deep-merges maps, so a malformed value nested inside an allowed field is
 * merged in silently and read back by ResultPeak as a component score for a
 * column that does not exist. A top-level key, a dotted path and a nested key
 * are therefore all checked, and checked identically.
 *
 * Call this before every write, and always write with merge - see
 * `db/academic-records.ts`.
 */
export function assertRecordFields(update: Record<string, unknown>): void {
  const keys = Object.keys(update);
  if (keys.length === 0) {
    throw new Error("Refusing an empty studentAcademicRecords write.");
  }

  for (const key of keys) {
    const segments = key.split(".");
    const root = segments[0] as string;

    if (!ALLOWED_RECORD_KEYS.has(root)) {
      // Deliberately does NOT claim the field belongs to ResultPeak. It might be
      // a typo, or a field neither platform has ever heard of; saying otherwise
      // sends the next reader looking through the wrong repo.
      throw new Error(
        `Refusing to write "${key}" on studentAcademicRecords. JDSmartLearn may ` +
          `write only ${LMS_WRITABLE_RECORD_FIELDS.join(", ")} (plus ` +
          `${RECORD_IDENTITY_FIELDS.join(", ")} on a create); "${root}" is not ` +
          `one of them. See CLAUDE.md, Assessment rules.`
      );
    }

    // An empty segment is `a..b`, which Firestore reads as a real empty path
    // component. Never intended, and it would land somewhere unpredictable.
    if (segments.some((s) => s.length === 0)) {
      throw new Error(`Refusing to write "${key}": empty path segment.`);
    }

    const depth = RECORD_FIELD_DEPTH[root] ?? 0;
    const spent = segments.length - 1;
    if (spent > depth) {
      throw new Error(
        `Refusing to write "${key}" on studentAcademicRecords. "${root}" is ` +
          `${depth === 0 ? "a single value" : `${depth} level(s) deep`}, so that ` +
          `path reaches past the end of it.`
      );
    }

    const value = update[key];
    if (root === "continuousAssessment") {
      assertCaValue(
        spent === 0 ? "continuousAssessment" : `"${key}"`,
        value,
        depth - spent
      );
      continue;
    }

    // The scalars. Checked because a map here would deep-merge into the shared
    // document too, and `lastUpdatedByLMS` is read as a timestamp by both sides.
    if (root === "lastUpdatedByLMS") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Refusing lastUpdatedByLMS: expected a timestamp number.`);
      }
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Refusing ${root}: expected a non-empty string.`);
    }
  }
}
