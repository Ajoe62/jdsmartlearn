/**
 * A list that hit its limit has probably left something out.
 *
 * PURE, so it is testable. Every capped Firestore query on a student path
 * passes its result size through `capWarning` and logs what comes back.
 *
 * WHY THIS EXISTS (2026-11-26). Student lists used to be capped at 50 with no
 * ordering, so once a class passed 50 assignments Firestore returned an
 * arbitrary 50, and work due tomorrow could silently drop off a child's screen.
 * The limits are now per school year and far higher, but a limit is still a
 * limit. A row that reaches it must be visible in the logs the day it happens,
 * not discovered when a parent asks why their child "didn't do" homework.
 */

/** The log line for a query that came back full, or null when it did not. */
export function capWarning(
  list: string,
  returned: number,
  limit: number,
  context: Record<string, string | null | undefined>
): string | null {
  if (returned < limit) return null;
  const where = Object.entries(context)
    .map(([k, v]) => `${k}=${v ?? "-"}`)
    .join(" ");
  return `[list-cap] ${list} returned ${returned} of limit ${limit}; some rows may be missing. ${where}`;
}

/** Log `capWarning` when it fires. Returns the rows unchanged, for chaining. */
export function reportIfCapped<T>(
  rows: T[],
  list: string,
  limit: number,
  context: Record<string, string | null | undefined>
): T[] {
  const warning = capWarning(list, rows.length, limit, context);
  if (warning) console.error(warning);
  return rows;
}
