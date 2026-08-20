import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "@/lib/db/collections";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import {
  getLesson,
  getGeneratedContent,
  writeAuditLog,
  toStudentPayload,
  clearStudentPayload,
} from "@/lib/db/lessons";
import { studentLessonsTag, lessonViewTag } from "@/lib/db/student-content";
import type { Topic } from "@/types";

/**
 * Publish reviewed materials. Teacher review is mandatory: a lesson cannot be
 * published unless generated content exists. Edits sent here mark tutorEdited,
 * which is a core quality metric.
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

  const content = await getGeneratedContent(id);
  if (!content) {
    return NextResponse.json(
      { error: "Create the study materials before publishing." },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    summary?: string;
    questions?: { number: number; question: string }[];
    markingGuide?: { number: number; keyPoints: string[] }[];
    baseUpdatedAt?: number;
  };

  /**
   * Staleness guard for a publish queued offline. Same reasoning as the PATCH
   * route: a publish carrying days-old edits must not overwrite a newer version
   * someone else reviewed. Only enforced when a baseline is supplied.
   */
  if (typeof body.baseUpdatedAt === "number" && body.baseUpdatedAt < lesson.updatedAt) {
    return NextResponse.json(
      {
        error:
          "This lesson changed while you were offline. Open it to review the newer version before publishing.",
        stale: true,
      },
      { status: 409 }
    );
  }

  const edited =
    (body.summary !== undefined && body.summary !== content.summary) ||
    body.questions !== undefined ||
    body.markingGuide !== undefined;

  if (edited) {
    await adminDb.doc(`${JD.generatedContent}/${content.id}`).update({
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.questions ? { questions: body.questions } : {}),
      ...(body.markingGuide ? { markingGuide: body.markingGuide } : {}),
      tutorEdited: true,
    });
  }

  // Resolve the topic title once, here, so a class sync never needs a topics read.
  const topicSnap = await adminDb.doc(`${JD.topics}/${lesson.topicId}`).get();
  const topic = topicSnap.data() as Topic | undefined;

  /**
   * Denormalize the student-safe guide onto the lesson so a whole class syncs in
   * one query (docs/OFFLINE-FIRST.md). Built from the EDITED values - what the
   * tutor just approved is what students get. toStudentPayload names its fields,
   * so body.markingGuide cannot ride along even though it is in scope here.
   */
  const payload = toStudentPayload(
    {
      summary: body.summary ?? content.summary,
      questions: body.questions ?? content.questions,
    },
    topic?.title ?? lesson.title
  );

  await adminDb.doc(`${JD.lessons}/${id}`).update({
    status: "published",
    publishedAt: Date.now(),
    studentPayload: payload,
    updatedAt: Date.now(),
  });

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.publish",
    entityId: id,
  });

  // Drop cached student reads so the new/updated lesson shows immediately.
  revalidateTag(studentLessonsTag(lesson.classId));
  revalidateTag(lessonViewTag(id));

  return NextResponse.json({ ok: true });
}

/** Unpublish the study guide: students stop seeing it, the content is kept. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  if (lesson.status !== "published") {
    return NextResponse.json({ error: "This study guide isn't published." }, { status: 400 });
  }

  await adminDb.doc(`${JD.lessons}/${id}`).update({
    status: "generated",
    publishedAt: null,
    updatedAt: Date.now(),
  });

  // Remove the denormalized copy too, or devices would keep syncing a guide the
  // tutor has withdrawn.
  await clearStudentPayload(id);

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.unpublish",
    entityId: id,
  });

  revalidateTag(studentLessonsTag(lesson.classId));
  revalidateTag(lessonViewTag(id));

  return NextResponse.json({ ok: true });
}
