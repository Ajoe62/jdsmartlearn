import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getLesson, setLessonFile, updateLessonDetails, writeAuditLog } from "@/lib/db/lessons";
import { studentLessonsTag, lessonViewTag } from "@/lib/db/student-content";
import { deleteFile, storageConfigured } from "@/lib/storage/provider";
import { lessonFileKey } from "@/lib/storage/keys";
import {
  UploadError,
  claimUpload,
  fileFields,
  readClaimedText,
  tutorActor,
} from "@/lib/storage/uploads";

export const maxDuration = 60;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Attach or replace the original file on an EXISTING lesson. Covers lessons
 * created before storage existed, uploads that failed, and corrections.
 *
 * Takes a staging key, not a file: the browser has already put the bytes in R2
 * (lib/upload-client.ts), because a Vercel function refuses bodies over 4.5 MB.
 *
 * Text is left alone - EXCEPT when the lesson has none yet, because its first
 * file was a scan. Then the new file's text is read and kept, so a tutor can fix
 * that lesson by uploading a readable copy instead of retyping it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const lesson = await getLesson(id);
  if (!lesson || lesson.schoolId !== session.schoolId) {
    return bad("Lesson not found.", 404);
  }
  try {
    assertClassAccess(session, lesson.classId);
    assertDocumentSubjectAccess(session, lesson);
  } catch {
    return bad("You don't teach that subject to that class.", 403);
  }

  if (!storageConfigured()) {
    return bad("File storage isn't set up yet. Ask your administrator.", 503);
  }

  const body = (await req.json().catch(() => null)) as
    | { uploadKey?: string; fileName?: string }
    | null;
  // A page from before direct uploads posts multipart, which is not JSON.
  if (!body) return bad("This page is out of date. Reload it, then attach the file again.");
  if (!body.uploadKey) return bad("Choose a file to attach.");

  /**
   * A REPLACEMENT MOVES TO THE NEW, SCHOOL-PREFIXED KEY even when the lesson
   * already has a file at a historic one. The old object is removed below by
   * the same branch that already handles a changed extension, because the
   * comparison is against the stored key rather than the extension.
   */
  let claimed;
  try {
    claimed = await claimUpload(tutorActor(session), "lesson", body.uploadKey, body.fileName, (ext) =>
      lessonFileKey(session.schoolId, id, ext)
    );
  } catch (err) {
    if (err instanceof UploadError) return bad(err.message, err.status);
    throw err;
  }

  // Same-extension replacements overwrite in place; different extensions leave
  // the old object behind - clean it up.
  if (lesson.fileKey && lesson.fileKey !== claimed.key) {
    try {
      await deleteFile(lesson.fileKey);
    } catch (err) {
      console.error(`lesson ${id}: removing replaced file failed`, err);
    }
  }

  await setLessonFile(id, fileFields(claimed));

  let textFound = (lesson.extractedText ?? "").trim().length > 0;
  if (!textFound) {
    const text = await readClaimedText(claimed);
    if (text) {
      await updateLessonDetails(id, { extractedText: text });
      textFound = true;
    }
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.file.attach",
    entityId: id,
    detail: lesson.fileKey ? "replaced" : "attached",
  });

  revalidateTag(lessonViewTag(id));
  revalidateTag(studentLessonsTag(lesson.classId));

  return NextResponse.json({
    ok: true,
    fileName: claimed.name,
    fileSize: claimed.size,
    textFound,
  });
}
