/**
 * Everything currently stopping a school's marks from getting where they belong,
 * gathered into ONE list a tutor can read.
 *
 * PURE. No Firestore, no `server-only`, no `next/*`, for the same reason as
 * `ca.ts` and `grading-recovery.ts`: the caller passes in what it read, and this
 * decides only what to say about it.
 *
 * WHY ONE LIST AND NOT A BANNER PER CONDITION. These conditions are independent
 * and can all be true at once. A school with no assessment type mapped AND no
 * grading secret has two separate problems, and a tutor who fixes the one banner
 * they can see will believe they are finished. A banner per condition is also how
 * a page ends up with four different pieces of chrome saying four versions of
 * "something is not working".
 *
 * ADDING A FIFTH CONDITION: put its id in `SkipReason`, its sentence in
 * `SKIP_TEXT`, its place in `SKIP_ORDER`, and detect it in `detectSkips`. There
 * is no new component to write and no new slot to find on the page.
 */

import { CA_SKIP_TEXT, decideCaTarget } from "./ca";
import type { CaSkipReason } from "./ca";

/**
 * Why something is not reaching where it should.
 *
 * The CA reasons come from `ca.ts`, which is where the sync itself decides them,
 * so the audit log and this surface can never describe the same condition
 * differently. `grading_disabled` is broader than CA: nothing is being marked at
 * all, so nothing gets as far as a report card either.
 */
export type SkipReason = CaSkipReason | "grading_disabled";

/**
 * Plain text for a tutor. No system nouns, no environment variable names, and
 * each one says who fixes it (CLAUDE.md, Interface writing).
 */
export const SKIP_TEXT: Record<SkipReason, string> = {
  ...CA_SKIP_TEXT,
  grading_disabled:
    "Work students send is not being marked automatically. Mark it yourself here, or ask whoever set up JDSmartLearn for your school to switch marking on.",
};

/**
 * Rendering order, widest problem first.
 *
 * `grading_disabled` leads because it stops the whole loop: with marking off
 * there is no score to release, so the CA problems below it are not yet the ones
 * costing anybody marks.
 */
export const SKIP_ORDER: SkipReason[] = [
  "grading_disabled",
  "no_settings",
  "mapping_unset",
  "type_removed",
  "nothing_released",
];

export interface SchoolSkipInput {
  /** From `gradingEnabled()`. Read server-side; never inferred in a browser. */
  gradingEnabled: boolean;
  /** The school's `jdSchoolSettings` document, or null when it has none. */
  settings: { lmsAssessmentType: string | null } | null;
  /** The stable `value` of each type on `schools/{id}.assessmentTypes`. */
  knownAssessmentTypeIds: string[];
}

/**
 * Every condition currently active, in reading order. Empty when all is well.
 *
 * The CA half defers to `decideCaTarget` rather than re-deriving the same three
 * cases: the page and the sync must agree, and the page had its own copy of this
 * ternary before, which is exactly the kind of pair that drifts.
 *
 * `nothing_released` is in `SKIP_TEXT` and `SKIP_ORDER` but is never produced
 * here, because it is per student and per subject rather than per school. It
 * belongs to the finalise path, and a caller holding one may pass it through.
 */
export function detectSkips(input: SchoolSkipInput): SkipReason[] {
  const active = new Set<SkipReason>();

  if (!input.gradingEnabled) active.add("grading_disabled");

  const target = decideCaTarget(input.settings, input.knownAssessmentTypeIds);
  if (target.status === "skipped") active.add(target.reason);

  return SKIP_ORDER.filter((reason) => active.has(reason));
}
