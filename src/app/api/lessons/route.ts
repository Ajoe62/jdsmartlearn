import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { extname } from "node:path";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP } from "@/lib/db/collections";
import {
  getTutorSession,
  assertClassAccess,
  assertSubjectAccess,
} from "@/lib/auth/tutor";
import { extractText, ExtractionError } from "@/lib/extract/text";
import {
  createLesson,
  setLessonFile,
  setMaterialPublished,
  writeAuditLog,
} from "@/lib/db/lessons";
import { studentLessonsTag } from "@/lib/db/student-content";
import { putFile, storageConfigured, STORABLE_TYPES } from "@/lib/storage/provider";
import type { ResultPeakClass, Topic } from "@/types";

export const maxDuration = 60;

/**
 * Create a lesson from an uploaded file or pasted text. The original file is
 * kept in R2 alongside the extracted text; text stays the student-facing default.
 */
export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const form = await req.formData();
  const classId = String(form.get("classId") ?? "");
  const topicId = String(form.get("topicId") ?? "");
  const title = String(form.get("title") ?? "").trim();
  const pasted = String(form.get("text") ?? "").trim();
  const file = form.get("file");
  /**
   * Publish the raw material as soon as the lesson lands.
   *
   * Exists so an offline-queued "create then publish material" collapses into one
   * request (see lib/offline/collapse.ts) instead of needing a dependent op that
   * waits for the server to assign an id. Study-guide publishing is untouched -
   * that still requires generation and the mandatory review gate.
   */
  const publishMaterial = String(form.get("publishMaterial") ?? "") === "true";

  if (!title || !classId || !topicId) {
    return NextResponse.json(
      { error: "Add a title and choose a class and topic." },
      { status: 400 }
    );
  }

  try {
    assertClassAccess(session, classId);
  } catch {
    return NextResponse.json({ error: "You don't teach that class." }, { status: 403 });
  }

  /**
   * Derive the topic and class facts server-side instead of trusting the form.
   *
   * The client used to supply subjectId and className verbatim, which meant a
   * lesson could be tagged with another school's topic (it is read straight into
   * the AI prompt) or given a spoofed class name. Both are denormalized onto the
   * lesson and would ride out to every student device.
   */
  const [topicSnap, classSnap] = await Promise.all([
    adminDb.doc(`${JD.topics}/${topicId}`).get(),
    adminDb.doc(`${RP.classes}/${classId}`).get(),
  ]);

  const topic = topicSnap.data() as Topic | undefined;
  if (!topic || topic.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "That topic isn't available." }, { status: 400 });
  }

  const cls = classSnap.data() as ResultPeakClass | undefined;
  if (!cls || cls.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "That class isn't available." }, { status: 400 });
  }

  // Trust the topic for the subject and the roster for the display name.
  const subjectId = topic.subjectId;
  const className = cls.name;

  /**
   * The subject check has to be HERE, not beside assertClassAccess above: the
   * client never sends a subject, it sends a topic, and the subject is whatever
   * that topic carries. Choosing another subject's topic is how a tutor would
   * otherwise create a lesson outside their allocation.
   */
  try {
    assertSubjectAccess(session, classId, subjectId);
  } catch {
    return NextResponse.json(
      { error: "You don't teach that subject to that class." },
      { status: 403 }
    );
  }

  let extractedText = pasted;
  try {
    if (file instanceof File && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) {
        return NextResponse.json({ error: "That file is over 10 MB." }, { status: 400 });
      }
      extractedText = await extractText(file);
    }
  } catch (err) {
    const message =
      err instanceof ExtractionError ? err.message : "We couldn't read that file.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (extractedText.length < 200) {
    return NextResponse.json(
      { error: "This lesson is too short to work with. Add more of the lesson text." },
      { status: 400 }
    );
  }

  const lessonId = await createLesson({
    schoolId: session.schoolId,
    tutorId: session.uid,
    topicId,
    classId,
    className,
    subjectId,
    title,
    extractedText,
    status: "draft",
  });

  // Keep the original file so students can download it as uploaded. Text is
  // the core loop - if storage isn't configured or the upload fails, the
  // lesson still works text-only.
  if (file instanceof File && file.size > 0 && storageConfigured()) {
    const ext = extname(file.name.toLowerCase());
    const storable = STORABLE_TYPES[ext];
    if (storable) {
      try {
        const key = `lessons/${lessonId}/original${ext}`;
        await putFile(key, Buffer.from(await file.arrayBuffer()), storable.mime);
        await setLessonFile(lessonId, {
          fileKey: key,
          fileName: file.name,
          fileSize: file.size,
          fileType: storable.mime,
        });
      } catch (err) {
        console.error(`lesson ${lessonId}: storing original failed`, err);
      }
    }
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.create",
    entityId: lessonId,
  });

  if (publishMaterial) {
    await setMaterialPublished(lessonId, true);
    await writeAuditLog({
      schoolId: session.schoolId,
      actorUid: session.uid,
      action: "lesson.material.publish",
      entityId: lessonId,
    });
    // Students in this class can see it now, so drop their cached list.
    revalidateTag(studentLessonsTag(classId));
  }

  return NextResponse.json({ lessonId });
}
