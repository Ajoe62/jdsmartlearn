import { NextResponse } from "next/server";
import { getTutorSession } from "@/lib/auth/tutor";
import { getSchool } from "@/lib/db/resultpeak";
import { saveColumnSetting } from "@/lib/db/school-settings";
import { writeAuditLog } from "@/lib/db/lessons";
import { isAdminColumnAllowed, type AdminColumnInfo } from "@/lib/assessment/ca";

/**
 * Save which report-card column older assignments feed. SCHOOL ADMIN ONLY.
 *
 * Not a tutor-level control: it decides where a whole school's coursework lands
 * on a result sheet.
 *
 * THE TERM AND SESSION ARE NOT SAVED HERE ANY MORE. They are ResultPeak's, set
 * in its School profile, and read through getCurrentTermSession(). A `term` or
 * `session` in the body is ignored, so an old form left open in a browser tab
 * cannot write a stale term back.
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface Body {
  lmsAssessmentType?: string | null;
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);
  if (!session.isAdmin) {
    return bad("Only a school admin can change assessment settings.", 403);
  }

  const body = (await req.json().catch(() => ({}))) as Body;

  // Validate against the SCHOOL's own list, by its stable `value`. Null is a
  // legitimate state and the one a school starts in.
  let lmsAssessmentType: string | null = null;
  if (body.lmsAssessmentType) {
    const school = await getSchool(session.schoolId);
    const raw = (school as { assessmentTypes?: AdminColumnInfo[] } | null)?.assessmentTypes;
    const types = Array.isArray(raw) ? raw : [];
    const column = types.find((t) => t.value === body.lmsAssessmentType);
    if (!column) {
      return bad("That assessment type is not on your school's list in ResultPeak.");
    }
    // Same rule the settings page uses to build its list, and the sync re-checks.
    if (!isAdminColumnAllowed(column, types)) {
      return bad("That column is for exams or system marks. Choose a coursework column.");
    }
    lmsAssessmentType = body.lmsAssessmentType;
  }

  await saveColumnSetting(session.schoolId, { lmsAssessmentType, updatedBy: session.uid });

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "school.settings.save",
    entityId: session.schoolId,
    detail: `lmsType=${lmsAssessmentType ?? "unset"}`,
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
