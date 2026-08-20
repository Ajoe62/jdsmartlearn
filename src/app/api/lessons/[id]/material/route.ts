import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getLesson, setMaterialPublished, writeAuditLog } from "@/lib/db/lessons";
import { studentLessonsTag, lessonViewTag } from "@/lib/db/student-content";

/**
 * Publish or hide the raw lesson material for students. Independent of the study
 * guide - a tutor can share the material immediately, before any AI generation.
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

  const body = (await req.json().catch(() => ({}))) as { publish?: boolean };
  const publish = body.publish !== false; // default to publishing

  await setMaterialPublished(id, publish);

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: publish ? "lesson.material.publish" : "lesson.material.hide",
    entityId: id,
  });

  // Drop cached student reads so the change shows immediately.
  revalidateTag(studentLessonsTag(lesson.classId));
  revalidateTag(lessonViewTag(id));

  return NextResponse.json({ ok: true, published: publish });
}
