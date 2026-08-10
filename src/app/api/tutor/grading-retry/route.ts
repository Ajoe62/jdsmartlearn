import { NextResponse } from "next/server";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getAssignment } from "@/lib/db/assignments";
import { getSubmission } from "@/lib/db/submissions";
import { retryOne, sweepAssignment } from "@/lib/db/grading-sweep";

/**
 * Retry marking that never happened.
 *
 *   scope=assignment  sweep every stuck submission on one assignment
 *   scope=submission  retry one row, from the tutor's explicit action
 *
 * Tutor-only, ownership checked, class checked fresh against ResultPeak.
 *
 * The sweep also runs silently when the submissions page loads. This route is
 * for the visible action and for a client-initiated retry after that page has
 * already rendered.
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const body = (await req.json().catch(() => ({}))) as {
    scope?: "assignment" | "submission";
    assignmentId?: string;
    submissionId?: string;
  };

  const origin = new URL(req.url).origin;

  if (body.scope === "submission") {
    const id = body.submissionId?.trim();
    if (!id) return bad("We couldn't tell which submission this is.");

    const submission = await getSubmission(id);
    if (!submission || submission.schoolId !== session.schoolId) {
      return bad("That submission no longer exists.", 404);
    }
    if (!session.isAdmin && submission.tutorId !== session.uid) {
      return bad("You didn't set this assignment.", 403);
    }
    try {
      assertClassAccess(session, submission.classId);
    } catch {
      return bad("You don't teach that class.", 403);
    }

    const result = await retryOne(session.schoolId, id, origin, session.uid);
    if (!result.ok) {
      const message =
        result.reason === "disabled"
          ? "Automatic marking is switched off for your school. Mark this one yourself."
          : result.reason === "capped"
            ? "We tried marking this several times and it did not work. Mark it yourself."
            : "This one is not waiting to be marked.";
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  }

  const assignmentId = body.assignmentId?.trim();
  if (!assignmentId) return bad("We couldn't tell which assignment this is.");

  const assignment = await getAssignment(assignmentId);
  if (!assignment || assignment.schoolId !== session.schoolId) {
    return bad("That assignment no longer exists.", 404);
  }
  if (!session.isAdmin && assignment.tutorId !== session.uid) {
    return bad("You didn't set this assignment.", 403);
  }
  try {
    assertClassAccess(session, assignment.classId);
  } catch {
    return bad("You don't teach that class.", 403);
  }

  // The tutor does not wait for a whole class to be re-sent for marking.
  const result = await sweepAssignment(
    session.schoolId,
    assignmentId,
    origin,
    session.uid
  );
  return NextResponse.json(result);
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
