/**
 * Term and session, as ResultPeak actually stores them.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: JDSmartLearn never constructs,
 * normalises, title cases, trims, or reformats a term or a session. It copies
 * what ResultPeak has, byte for byte, and compares with `===`.
 *
 * Why that is not fussiness. ResultPeak joins a student's marks into one result
 * sheet with `getTermKey()` in `src/lib/termResultData.js`, which concatenates
 * the literal strings:
 *
 *   studentId__schoolId__classId__academicSession__term
 *
 * with the fallbacks "Unspecified Session" and "Unspecified Term". A difference
 * of one space or one capital letter does not throw. It silently produces a
 * SECOND result sheet that nobody looks at. The string exists to join, not to be
 * read, so being tidy is worth nothing and being exact is worth everything.
 */

/**
 * ResultPeak's three terms, copied byte for byte.
 *
 * There is no stable id for a term anywhere in ResultPeak and no list of them in
 * Firestore. This array is duplicated as a hardcoded `const TERMS` in THREE
 * files in the ResultPeak repo:
 *
 *   src/components/exams/ExamCoverageGrid.tsx:39
 *   src/components/exams/ExamForm.tsx:20
 *   src/pages/admin/ManageExamsPage.jsx:36
 *
 * RECHECK THIS CONSTANT if any of those three change. A term string that does
 * not match theirs exactly will never appear on a result sheet.
 */
export const RESULTPEAK_TERMS = ["First Term", "Second Term", "Third Term"] as const;

/**
 * A term string. Deliberately `string`, not a union of the three above and not a
 * number.
 *
 * A union would tempt a future change to normalise an unrecognised value into a
 * member of it, and a number would need a mapping table, which is the thing that
 * silently stops joining the day ResultPeak adds a fourth term. Values are
 * validated against RESULTPEAK_TERMS on the write path and stored verbatim.
 */
export type AcademicTerm = string;

/** An academic session, e.g. "2025/2026". Free text in ResultPeak. Verbatim here. */
export type AcademicSession = string;

/** Exact membership. No trim, no case folding, no coercion. */
export function isKnownTerm(term: string): boolean {
  return (RESULTPEAK_TERMS as readonly string[]).includes(term);
}

/**
 * A session as ResultPeak's School profile saves it: two consecutive years with
 * a slash, "2026/2027". Checked as written, never repaired: "2026-27" or
 * " 2026/2027" is refused, not tidied.
 */
export function isProfileSession(session: string): boolean {
  const m = /^(\d{4})\/(\d{4})$/.exec(session);
  return m !== null && Number(m[2]) === Number(m[1]) + 1;
}

/** The school's current term and session, as ResultPeak's School profile holds them. */
export interface SchoolCalendar {
  term: AcademicTerm;
  session: AcademicSession;
}

/**
 * Read `schools/{id}.currentTerm` and `.currentSession`, the fields ResultPeak's
 * School profile saves. The mirror of ResultPeak's `resolveSchoolCalendar()` in
 * `src/lib/academicCalendar.js`, and it must stay one: both products have to
 * name the same current term, or a mark stamped here is filed under a different
 * term over there.
 *
 * BOTH OR NEITHER. If either is missing or not exactly valid, the school has not
 * set its term, and the answer is null. Never one field without the other, never
 * a tidied string, never a term worked out from the date.
 */
export function resolveSchoolCalendar(
  school: { currentTerm?: unknown; currentSession?: unknown } | null | undefined
): SchoolCalendar | null {
  const term = school?.currentTerm;
  const session = school?.currentSession;
  if (typeof term !== "string" || !isKnownTerm(term)) return null;
  if (typeof session !== "string" || !isProfileSession(session)) return null;
  return { term, session };
}

/** Exact membership against the school's own observed sessions. */
export function isKnownSession(session: string, knownSessions: readonly string[]): boolean {
  return knownSessions.includes(session);
}

/**
 * Display order for the three terms.
 *
 * Derived at read time from position in RESULTPEAK_TERMS, never stored. An order
 * field on the document would be a second copy of the same fact and would drift
 * from the value it describes. An unknown term sorts last rather than throwing:
 * this is presentation, and a sheet that renders in an odd order beats one that
 * does not render.
 */
export function termOrder(term: string): number {
  const index = (RESULTPEAK_TERMS as readonly string[]).indexOf(term);
  return index === -1 ? RESULTPEAK_TERMS.length : index;
}

/** Newest session first. "2026/2027" sorts above "2025/2026" by plain compare. */
export function sortSessionsDescending(sessions: string[]): string[] {
  return [...sessions].sort((a, b) => b.localeCompare(a));
}
