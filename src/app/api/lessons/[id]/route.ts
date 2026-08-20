import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getLesson, deleteLesson, updateLessonDetails, writeAuditLog } from "@/lib/db/lessons";
import { getClassesByIds } from "@/lib/db/resultpeak";
import { studentLessonsTag, lessonViewTag } from "@/lib/db/student-content";
import { deleteFile } from "@/lib/storage/provider";
import type { Lesson } from "@/types";

const MAX_TEXT_CHARS = 800_000;

/**
 * Edit a lesson after creation: title and material text for any tutor with
 * class access; moving it to another class is ADMIN ONLY. Published content
 * stays published - edits go live to students on save (cache is invalidated).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    extractedText?: string;
    classId?: string;
    baseUpdatedAt?: number;
  };

  /**
   * Staleness guard for edits queued offline.
   *
   * An offline edit can arrive days later, after someone else has changed the same
   * lesson. This route only writes the fields that differ from CURRENT state, so
   * without this check a stale patch would silently clobber the newer version.
   * Refuse instead and let the tutor decide - losing their work quietly is worse
   * than asking. Only enforced when the caller supplies a baseline, so the online
   * form is unaffected.
   */
  if (typeof body.baseUpdatedAt === "number" && body.baseUpdatedAt < lesson.updatedAt) {
    return NextResponse.json(
      {
        error:
          "This lesson changed while you were offline. Open it to see the newer version.",
        stale: true,
      },
      { status: 409 }
    );
  }

  const patch: Partial<Pick<Lesson, "title" | "extractedText" | "classId" | "className">> = {};
  const changed: string[] = [];

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (title.length < 3 || title.length > 150) {
      return NextResponse.json(
        { error: "The title needs to be between 3 and 150 characters." },
        { status: 400 }
      );
    }
    if (title !== lesson.title) {
      patch.title = title;
      changed.push("title");
    }
  }

  if (body.extractedText !== undefined) {
    const text = body.extractedText.trim();
    if (text.length < 20) {
      return NextResponse.json(
        { error: "The material is too short. Add at least a few sentences." },
        { status: 400 }
      );
    }
    if (text.length > MAX_TEXT_CHARS) {
      return NextResponse.json(
        { error: "The material is too long. Shorten it and try again." },
        { status: 400 }
      );
    }
    if (text !== lesson.extractedText) {
      patch.extractedText = text;
      changed.push("material");
    }
  }

  if (body.classId !== undefined && body.classId !== lesson.classId) {
    if (!session.isAdmin) {
      return NextResponse.json(
        { error: "Only a school admin can move a lesson to another class." },
        { status: 403 }
      );
    }
    const [target] = await getClassesByIds([body.classId]);
    if (!target || target.schoolId !== session.schoolId) {
      return NextResponse.json({ error: "That class doesn't exist." }, { status: 400 });
    }
    patch.classId = target.id;
    patch.className = target.name;
    changed.push("class");
  }

  if (changed.length === 0) return NextResponse.json({ ok: true, changed });

  await updateLessonDetails(id, patch);

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.edit",
    entityId: id,
    detail: changed.join(","),
  });

  // Invalidate student caches: the lesson view, the old class list, and - if
  // the lesson moved - the new class list.
  revalidateTag(lessonViewTag(id));
  revalidateTag(studentLessonsTag(lesson.classId));
  if (patch.classId) revalidateTag(studentLessonsTag(patch.classId));

  return NextResponse.json({ ok: true, changed });
}

/** Delete a lesson entirely - its content, receipts, and the lesson itself. */
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

  await deleteLesson(id);

  // Remove the stored original too; an orphaned blob is not worth failing the delete.
  if (lesson.fileKey) {
    try {
      await deleteFile(lesson.fileKey);
    } catch (err) {
      console.error(`lesson ${id}: deleting stored file failed`, err);
    }
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.delete",
    entityId: id,
  });

  revalidateTag(studentLessonsTag(lesson.classId));
  revalidateTag(lessonViewTag(id));

  return NextResponse.json({ ok: true });
}
