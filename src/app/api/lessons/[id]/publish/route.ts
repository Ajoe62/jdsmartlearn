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
  toStudentSections,
  clearStudentPayload,
} from "@/lib/db/lessons";
import { listTopics } from "@/lib/db/topics";
import { cleanSections, topicsOf } from "@/lib/notes/arrange";
import { studentLessonsTag, lessonViewTag } from "@/lib/db/student-content";
import type { NoteSection, NoteTopic, Topic } from "@/types";

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
    /** Weekly notes: the topic sections as the tutor left them on review. */
    sections?: unknown;
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

  /**
   * Topic sections, weekly notes only. Edited sections are validated - a topic
   * id must be one this school has for this subject, or it is dropped to a plain
   * name - and unedited ones are the generated set as stored.
   */
  const weekly = lesson.kind === "weekly";
  let sections: NoteSection[] | undefined;
  if (weekly && body.sections !== undefined) {
    const allowed = (await listTopics(session.schoolId))
      .filter((t) => t.subjectId === lesson.subjectId)
      .map((t) => ({ id: t.id, title: t.title }));
    const cleaned = cleanSections(body.sections, allowed);
    if ("error" in cleaned) {
      return NextResponse.json({ error: cleaned.error }, { status: 400 });
    }
    sections = cleaned;
  } else if (weekly) {
    sections = content.sections;
  }

  const edited =
    (body.summary !== undefined && body.summary !== content.summary) ||
    body.questions !== undefined ||
    body.markingGuide !== undefined ||
    (weekly && body.sections !== undefined);

  if (edited) {
    await adminDb.doc(`${JD.generatedContent}/${content.id}`).update({
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.questions ? { questions: body.questions } : {}),
      ...(body.markingGuide ? { markingGuide: body.markingGuide } : {}),
      ...(weekly && body.sections !== undefined && sections ? { sections } : {}),
      tutorEdited: true,
    });
  }

  // Resolve the topic title once, here, so a class sync never needs a topics read.
  const topicSnap = lesson.topicId
    ? await adminDb.doc(`${JD.topics}/${lesson.topicId}`).get()
    : null;
  const topic = topicSnap?.data() as Topic | undefined;
  const topicTitle = topic?.title ?? lesson.topicTitle ?? lesson.title;

  /**
   * The topic labels the student shelf groups by: one for a topic note, one per
   * distinct section topic for a weekly note.
   */
  const topics: NoteTopic[] =
    sections && sections.length > 0
      ? topicsOf(sections)
      : [{ id: lesson.topicId, title: topicTitle }];

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
    topicTitle,
    { topics, sectionCount: sections?.length ?? 0 }
  );

  await adminDb.doc(`${JD.lessons}/${id}`).update({
    status: "published",
    publishedAt: Date.now(),
    studentPayload: payload,
    // Sections live on the lesson, not in the payload - see Lesson.studentSections.
    ...(sections && sections.length > 0
      ? { studentSections: toStudentSections(sections) }
      : {}),
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

  // Remove the denormalized copy (and a weekly note's sections) too, or devices would keep syncing a guide the
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
