import "server-only";
import { getColumnSetting } from "./school-settings";
import { resolveSchoolCalendar } from "@/lib/academic-calendar";
import { getSchool } from "./resultpeak";
import { gradingEnabled } from "./grading-sweep";
import { detectSkips } from "@/lib/assessment/skips";
import type { SkipReason } from "@/lib/assessment/skips";
import type { AdminColumnInfo } from "@/lib/assessment/ca";

/**
 * Everything currently stopping one school's marks getting where they belong.
 *
 * THE ONLY WAY A PAGE ASKS THIS QUESTION. Two tutor pages render the surface,
 * and each one used to gather the inputs itself: read the settings, read the
 * school, map assessment types to their `value`, call `detectSkips`. Four steps
 * repeated is four chances for one page to drift from the other and quietly
 * report fewer problems than exist, which is exactly the failure the single
 * shared surface was built to prevent.
 *
 * `gradingEnabled()` is read HERE, on the server, never passed in from a caller
 * that guessed. INTERNAL_TASK_SECRET is a server secret and must not be
 * inferred in a browser (CLAUDE.md, Security rule 3).
 *
 * COST: two document gets, both single-document and schoolId-keyed, no queries
 * and no fan-out. That is what makes it affordable on every tutor page rather
 * than only on the one page somebody happened to open.
 */
export async function getSchoolSkips(schoolId: string): Promise<SkipReason[]> {
  const [column, school] = await Promise.all([getColumnSetting(schoolId), getSchool(schoolId)]);
  // No current term in ResultPeak's School profile reads as `no_settings`. The
  // same rule as getCurrentTermSession(), on the school document already read.
  const settings = resolveSchoolCalendar(school as Record<string, unknown> | null) ? column : null;

  /**
   * The school's list is re-read every time rather than trusted from the
   * setting, because ResultPeak lets an admin drop an assessment type after
   * scores exist. A mapping that was valid last term can point at nothing today,
   * and `type_removed` is how a tutor finds out before a result sheet does.
   */
  const types =
    (school as { assessmentTypes?: AdminColumnInfo[] } | null)?.assessmentTypes ?? [];

  return detectSkips({
    gradingEnabled: gradingEnabled(),
    settings,
    knownAssessmentTypeIds: types.map((t) => t.value),
    columns: types,
  });
}
