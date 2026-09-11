import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getAssignment } from "@/lib/db/assignments";
import { getSubmission, submissionId } from "@/lib/db/submissions";
import { serveStoredFile } from "@/lib/storage/serve";

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
  req: Request,
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
      // Unlike finalise-assignment and grading-retry, this route has no
      // "did you set this assignment" check, so class access alone would let a
      // colleague teaching another subject in the same class pull down a
      // student's submitted work.
      assertDocumentSubjectAccess(tutor, assignment);
    } catch {
      return NextResponse.json(
        { error: "You don't teach that subject to that class." },
        { status: 403 }
      );
    }
    // A tutor names the student explicitly; a student never can.
    targetStudentId = new URL(req.url).searchParams.get("student");
    if (!targetStudentId) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
  }

  const submission = await getSubmission(submissionId(assignmentId, targetStudentId));
  const attachment = submission?.attachments[position];
  if (!attachment) return NextResponse.json({ error: "File not found." }, { status: 404 });

  return serveStoredFile({
    key: attachment.key,
    name: attachment.name,
    fallbackName: "attachment",
    size: attachment.size,
    // Private: this is one child's work, and shared phones are the norm.
    cacheControl: "private, no-store",
  });
}
