import { NextResponse } from "next/server";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getStudentSession } from "@/lib/auth/student";
import { getLesson } from "@/lib/db/lessons";
import { getFile } from "@/lib/storage/provider";

/**
 * Serve a lesson's original file. NEVER public: every request re-checks
 * authorization server-side (security rules #2 and #5).
 * - Tutors/admins: same school + class access.
 * - Students: same school + own class + material must be published.
 * PDFs and text render inline; docx always downloads.
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
    } catch {
      console.warn(
        `[file] ${id}: reject - tutor ${tutor.uid} lacks class ${lesson.classId} (has ${JSON.stringify(tutor.assignedClasses)})`
      );
      return NextResponse.json({ error: "You don't teach that class." }, { status: 403 });
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

  const stored = await getFile(lesson.fileKey);
  if (!stored) {
    return NextResponse.json({ error: "The file is no longer available." }, { status: 404 });
  }

  const mime = lesson.fileType ?? stored.contentType ?? "application/octet-stream";
  const inline = mime.startsWith("application/pdf") || mime.startsWith("text/");
  // ASCII-safe filename for the header.
  const safeName = (lesson.fileName ?? "lesson-file").replace(/[^\w.\- ]+/g, "_");

  return new NextResponse(new Uint8Array(stored.body), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(stored.body.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      // Private: browsers may cache locally, shared caches must not.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
