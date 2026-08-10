import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getAssignment } from "@/lib/db/assignments";
import { getSubmission, submissionId } from "@/lib/db/submissions";
import { getFile, STORABLE_TYPES } from "@/lib/storage/provider";

/**
 * Serve one attachment from a submission. NEVER public.
 *
 * The document stores an R2 key, never a URL, so there is no address for this
 * file that skips this check. Authorization is re-run on every request:
 *
 *  - a student may read only their OWN submission's attachments
 *  - a tutor may read attachments on an assignment they set, in a class they
 *    still teach
 *
 * `studentId` comes from the session, never from the URL, so there is nothing to
 * enumerate: changing the assignment id in the address bar returns your own
 * submission for that assignment or a 404.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ assignmentId: string; index: string }> }
) {
  const { assignmentId, index } = await ctx.params;
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0) {
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  }

  const assignment = await getAssignment(assignmentId);
  if (!assignment) return NextResponse.json({ error: "File not found." }, { status: 404 });

  const student = await getStudentSession();
  let targetStudentId: string | null = null;

  if (student) {
    if (
      assignment.schoolId !== student.schoolId ||
      assignment.classId !== student.classId
    ) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    targetStudentId = student.studentId;
  } else {
    const tutor = await getTutorSession();
    if (!tutor) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    if (assignment.schoolId !== tutor.schoolId) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    try {
      assertClassAccess(tutor, assignment.classId);
    } catch {
      return NextResponse.json({ error: "You don't teach that class." }, { status: 403 });
    }
    // A tutor names the student explicitly; a student never can.
    const url = new URL(_req.url);
    targetStudentId = url.searchParams.get("student");
    if (!targetStudentId) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
  }

  const submission = await getSubmission(submissionId(assignmentId, targetStudentId));
  const attachment = submission?.attachments[position];
  if (!attachment) return NextResponse.json({ error: "File not found." }, { status: 404 });

  const stored = await getFile(attachment.key);
  if (!stored) return NextResponse.json({ error: "File not found." }, { status: 404 });

  const inline = Object.values(STORABLE_TYPES).find((t) => t.mime === attachment.type)?.inline;

  return new NextResponse(new Uint8Array(stored.body), {
    headers: {
      "Content-Type": attachment.type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(attachment.name)}"`,
      // Private: this is one child's work, and shared phones are the norm.
      "Cache-Control": "private, no-store",
    },
  });
}
