import { NextResponse } from "next/server";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getStudentSession } from "@/lib/auth/student";
import { getAssignment } from "@/lib/db/assignments";
import { serveStoredFile } from "@/lib/storage/serve";

/**
 * Serve an assignment's question sheet. NEVER public: every request re-checks
 * authorization server-side, exactly like /api/lessons/[id]/file.
 *
 *  - Tutors/admins: same school, class access, and subject access.
 *  - Students:      same school, own class, and the assignment must be switched
 *                   on - a draft assignment is not yet a child's to read.
 *
 * The sheet is not the marking guide. The guide is text on the assignment
 * document and is only ever sent to tutors; the sheet is a file the tutor chose
 * to show students. The R2 key never leaves the server.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const assignment = await getAssignment(id);
  if (!assignment?.fileKey) {
    return NextResponse.json({ error: "No question sheet for this assignment." }, { status: 404 });
  }

  const tutor = await getTutorSession();
  if (tutor) {
    if (assignment.schoolId !== tutor.schoolId) {
      return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
    }
    try {
      assertClassAccess(tutor, assignment.classId);
      assertDocumentSubjectAccess(tutor, assignment);
    } catch {
      return NextResponse.json(
        { error: "You don't teach that class and subject." },
        { status: 403 }
      );
    }
  } else {
    const student = await getStudentSession();
    if (!student) {
      // A pasted link in a browser should land on sign-in, not raw JSON.
      if (req.headers.get("accept")?.includes("text/html")) {
        return NextResponse.redirect(new URL("/student/sign-in", req.url));
      }
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    }
    if (
      assignment.schoolId !== student.schoolId ||
      assignment.classId !== student.classId ||
      !assignment.isActive
    ) {
      // One message for every refusal, so a guessed id confirms nothing.
      return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
    }
  }

  return serveStoredFile({
    key: assignment.fileKey,
    name: assignment.fileName,
    fallbackName: "question-sheet",
    size: assignment.fileSize,
    // Private: browsers may cache locally, shared caches must not.
    cacheControl: "private, max-age=3600",
  });
}
