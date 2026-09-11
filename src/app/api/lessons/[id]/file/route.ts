import { NextResponse } from "next/server";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getStudentSession } from "@/lib/auth/student";
import { getLesson } from "@/lib/db/lessons";
import { serveStoredFile } from "@/lib/storage/serve";

/**
 * Serve a lesson's original file. NEVER public: every request re-checks
 * authorization server-side (security rules #2 and #5).
 * - Tutors/admins: same school + class access.
 * - Students: same school + own class + material must be published.
 *
 * How the bytes travel - streamed, or a short-lived redirect for files over
 * 4 MB - is serve.ts's business, and happens only after the checks below pass.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const lesson = await getLesson(id);
  if (!lesson?.fileKey) {
    console.warn(`[file] ${id}: reject - no lesson or no fileKey`);
    return NextResponse.json({ error: "No file for this lesson." }, { status: 404 });
  }

  // Tutor path first; fall back to student path.
  const tutor = await getTutorSession();
  if (tutor) {
    if (lesson.schoolId !== tutor.schoolId) {
      console.warn(
        `[file] ${id}: reject - tutor ${tutor.uid} school ${tutor.schoolId} != lesson school ${lesson.schoolId}`
      );
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }
    try {
      assertClassAccess(tutor, lesson.classId);
      // Subject scoping applies to the TUTOR branch only. Students have no
      // allocation; their branch below is gated on their own class plus
      // materialPublishedAt.
      assertDocumentSubjectAccess(tutor, lesson);
    } catch {
      console.warn(
        `[file] ${id}: reject - tutor ${tutor.uid} lacks ${lesson.classId}/${lesson.subjectId} (classes ${JSON.stringify(tutor.assignedClasses)})`
      );
      return NextResponse.json(
        { error: "You don't teach that class and subject." },
        { status: 403 }
      );
    }
  } else {
    const student = await getStudentSession();
    if (!student) {
      console.warn(`[file] ${id}: reject - no tutor or student session on request`);
      // A pasted link in a browser should land on sign-in, not raw JSON.
      if (req.headers.get("accept")?.includes("text/html")) {
        return NextResponse.redirect(new URL("/student/sign-in", req.url));
      }
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    }
    if (
      lesson.schoolId !== student.schoolId ||
      lesson.classId !== student.classId ||
      !lesson.materialPublishedAt
    ) {
      console.warn(
        `[file] ${id}: reject - student ${student.studentId} school=${student.schoolId} class=${student.classId} vs lesson school=${lesson.schoolId} class=${lesson.classId} materialPublishedAt=${lesson.materialPublishedAt ?? "unset"}`
      );
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }
  }

  return serveStoredFile({
    key: lesson.fileKey,
    name: lesson.fileName,
    fallbackName: "lesson-file",
    size: lesson.fileSize,
    // Private: browsers may cache locally, shared caches must not.
    cacheControl: "private, max-age=3600",
  });
}
