import { NextResponse } from "next/server";
import { getTutorSession } from "@/lib/auth/tutor";
import { getSchool } from "@/lib/db/resultpeak";
import { observedSessions, saveSchoolSettings } from "@/lib/db/school-settings";
import { writeAuditLog } from "@/lib/db/lessons";
import { isKnownTerm } from "@/lib/academic-calendar";

/**
 * Save a school's assessment settings. SCHOOL ADMIN ONLY.
 *
 * Not a tutor-level control. The term, the session and the assessment type the
 * LMS feeds decide where every child's coursework lands on a result sheet, and
 * a tutor changing them would silently re-file a whole class.
 *
 * NOTHING here trims, lower cases, or otherwise reshapes `term` or `session`.
 * They are stored exactly as chosen. ResultPeak joins result sheets on the
 * literal strings, so a value we tidied is a value that no longer joins.
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface Body {
  term?: string;
  session?: string;
  /** The admin explicitly chose a session their data does not contain. */
  sessionIsOverride?: boolean;
  lmsAssessmentType?: string | null;
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);
  if (!session.isAdmin) {
    return bad("Only a school admin can change assessment settings.", 403);
  }

  const body = (await req.json().catch(() => ({}))) as Body;

  // Read raw. No trim, deliberately: see the note at the top of this file.
  const term = body.term;
  const chosenSession = body.session;

  if (typeof term !== "string" || !isKnownTerm(term)) {
    return bad("Choose one of the three terms.");
  }
  if (typeof chosenSession !== "string" || chosenSession === "") {
    return bad("Choose an academic session.");
  }

  const observed = await observedSessions(session.schoolId);
  const observedValues = observed.map((o) => o.session);
  const isOverride = body.sessionIsOverride === true;

  /**
   * Exact membership, no normalisation. Without the override flag a session the
   * school's own exams and results have never carried is refused, because CA
   * written under it would join to nothing and look like it simply vanished.
   */
  if (!isOverride && !observedValues.includes(chosenSession)) {
    return bad(
      "That session does not appear in your school's exams or results. Pick one that does, or turn on the override and accept that it will not show on a result sheet."
    );
  }

  // Validate the assessment type against the SCHOOL's own list, by its stable
  // `value`. Null is a legitimate state and the one a school starts in.
  let lmsAssessmentType: string | null = null;
  if (body.lmsAssessmentType) {
    const school = await getSchool(session.schoolId);
    const types = (school as { assessmentTypes?: { value: string }[] } | null)
      ?.assessmentTypes;
    const known = Array.isArray(types) ? types.map((t) => t.value) : [];
    if (!known.includes(body.lmsAssessmentType)) {
      return bad("That assessment type is not on your school's list in ResultPeak.");
    }
    lmsAssessmentType = body.lmsAssessmentType;
  }

  /**
   * Snapshot what was offered, plus the chosen value. The write path validates
   * an assignment's session against this list, so it never needs a query of its
   * own. An override lands here too, which is what makes it usable at all.
   */
  const knownSessions = observedValues.includes(chosenSession)
    ? observedValues
    : [chosenSession, ...observedValues];

  await saveSchoolSettings(session.schoolId, {
    term,
    session: chosenSession,
    knownSessions,
    sessionIsOverride: isOverride && !observedValues.includes(chosenSession),
    lmsAssessmentType,
    updatedBy: session.uid,
  });

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "school.settings.save",
    entityId: session.schoolId,
    detail: [
      `term=${term}`,
      `session=${chosenSession}`,
      `override=${isOverride}`,
      `lmsType=${lmsAssessmentType ?? "unset"}`,
    ].join(" "),
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
