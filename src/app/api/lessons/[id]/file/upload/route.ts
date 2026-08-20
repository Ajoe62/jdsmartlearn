import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { extname } from "node:path";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getLesson, setLessonFile, writeAuditLog } from "@/lib/db/lessons";
import { studentLessonsTag, lessonViewTag } from "@/lib/db/student-content";
import { deleteFile, putFile, storageConfigured, STORABLE_TYPES } from "@/lib/storage/provider";

export const maxDuration = 60;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Attach or replace the original file on an EXISTING lesson. Covers lessons
 * created before storage existed, uploads that failed, and corrections.
 * Text extraction is untouched - this only stores the downloadable original.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getTutorSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const lesson = await getLesson(id);
  if (!lesson || lesson.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
  }
  try {
    assertClassAccess(session, lesson.classId);
    assertDocumentSubjectAccess(session, lesson);
  } catch {
    return NextResponse.json(
      { error: "You don't teach that subject to that class." },
      { status: 403 }
    );
  }

  if (!storageConfigured()) {
    return NextResponse.json(
      { error: "File storage isn't set up yet. Ask your administrator." },
      { status: 503 }
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Choose a file to attach." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: "That file is over 10 MB. Use a smaller file." },
      { status: 400 }
    );
  }
  const ext = extname(file.name.toLowerCase());
  const storable = STORABLE_TYPES[ext];
  if (!storable) {
    return NextResponse.json(
      { error: "Use a PDF, Word (.docx), or text file." },
      { status: 400 }
    );
  }

  const key = `lessons/${id}/original${ext}`;
  try {
    await putFile(key, Buffer.from(await file.arrayBuffer()), storable.mime);
  } catch (err) {
    console.error(`lesson ${id}: attaching file failed`, err);
    return NextResponse.json(
      { error: "Storing the file failed. Check your connection and try again." },
      { status: 502 }
    );
  }

  // Same-extension replacements overwrite in place; different extensions leave
  // the old object behind - clean it up.
  if (lesson.fileKey && lesson.fileKey !== key) {
    try {
      await deleteFile(lesson.fileKey);
    } catch (err) {
      console.error(`lesson ${id}: removing replaced file failed`, err);
    }
  }

  await setLessonFile(id, {
    fileKey: key,
    fileName: file.name,
    fileSize: file.size,
    fileType: storable.mime,
  });

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.file.attach",
    entityId: id,
    detail: lesson.fileKey ? "replaced" : "attached",
  });

  revalidateTag(lessonViewTag(id));
  revalidateTag(studentLessonsTag(lesson.classId));

  return NextResponse.json({ ok: true, fileName: file.name, fileSize: file.size });
}
