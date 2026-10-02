import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP } from "@/lib/db/collections";
import { assertWritable } from "@/lib/db/write-guard";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getLesson, countGenerationsToday, writeAuditLog } from "@/lib/db/lessons";
import { getSubjects } from "@/lib/db/resultpeak";
import { generateStudyMaterials } from "@/lib/ai/provider";
import { MIN_USABLE_CHARS } from "@/lib/extract/text";
import { GenerationError } from "@/lib/ai/errors";
import { MAX_LESSON_CHARS } from "@/lib/ai/prompt";
import { listTopics } from "@/lib/db/topics";
import { classLevel } from "@/lib/class-level";
import { assembleSections, numberedText, splitParagraphs } from "@/lib/notes/arrange";
import { weekLabel } from "@/lib/notes/group";
import type { ClassLevel, ResultPeakClass, Topic } from "@/types";

export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  /**
   * No text, no study guide. A lesson whose original is a scan or a slide deck
   * is created with empty text on purpose (owner's decision, 2026-09-11), and
   * sending the model an empty lesson would spend the daily cap on a guide
   * invented from the topic title alone. Checked BEFORE the cap, so a refusal
   * here costs the tutor nothing.
   */
  if ((lesson.extractedText ?? "").trim().length < MIN_USABLE_CHARS) {
    return NextResponse.json(
      {
        error: `This lesson needs at least ${MIN_USABLE_CHARS} characters of text before we can make a study guide. Add the lesson text under Edit lesson, then try again.`,
      },
      { status: 400 }
    );
  }

  const cap = Number(process.env.MAX_GENERATIONS_PER_TUTOR_PER_DAY ?? 20);
  if ((await countGenerationsToday(session.schoolId, session.uid)) >= cap) {
    return NextResponse.json(
      { error: `You've reached today's limit of ${cap} generations. Try again tomorrow.` },
      { status: 429 }
    );
  }

  const weekly = lesson.kind === "weekly";
  const [topicSnap, classSnap, subjects, schoolTopics] = await Promise.all([
    lesson.topicId ? adminDb.doc(`${JD.topics}/${lesson.topicId}`).get() : Promise.resolve(null),
    adminDb.doc(`${RP.classes}/${lesson.classId}`).get(),
    getSubjects(session.schoolId),
    // One bounded query, only for a weekly note: the topics it may be sorted into.
    weekly ? listTopics(session.schoolId) : Promise.resolve([] as Topic[]),
  ]);
  const topic = topicSnap?.data() as Topic | undefined;
  const subjectName =
    subjects.find((s) => s.id === lesson.subjectId)?.name ?? lesson.subjectId;

  /**
   * The reading level. A weekly note has no topic to carry one, so the class
   * is the source - and it is the better source anyway, since a topic's level
   * is only ever the class's copied.
   */
  const level: ClassLevel =
    topic?.level ?? classLevel((classSnap.data() as ResultPeakClass | undefined) ?? {}) ?? "SS2";

  /**
   * A weekly note's sort targets: this school's topics for this subject at this
   * level - curriculum titles, no personal data. Narrowed to the level so a
   * JSS1 week is never filed under an SS3 topic of the same subject.
   */
  const candidates = schoolTopics
    .filter((t) => t.subjectId === lesson.subjectId && t.level === level)
    .slice(0, 60)
    .map((t) => ({ id: t.id, title: t.title }));
  const paragraphs = weekly ? splitParagraphs(lesson.extractedText) : [];
  const heading = weekLabel(lesson.week ?? null);

  await adminDb.doc(`${JD.lessons}/${id}`).update({ status: "generating", updatedAt: Date.now() });

  try {
    // Payload carries lesson content only - no names, no ids. See CLAUDE.md.
    const { result, meta } = await generateStudyMaterials({
      lessonText: weekly ? numberedText(paragraphs, MAX_LESSON_CHARS) : lesson.extractedText,
      subjectName,
      topicTitle: topic?.title ?? (weekly ? `${heading} notes` : lesson.title),
      level,
      ...(weekly
        ? { weekly: { week: lesson.week ?? null, topics: candidates.map((c) => c.title) } }
        : {}),
    });

    /**
     * The sections are BUILT here from the tutor's own paragraphs; the model
     * supplied only numbers. Whatever it returned, every paragraph lands in
     * exactly one section, in the tutor's words.
     */
    const { sections: arranged, ...guide } = result;
    const sections = weekly
      ? assembleSections(paragraphs, arranged ?? [], candidates, `${heading} notes`)
      : undefined;

    assertWritable(JD.generatedContent);
    await adminDb.collection(JD.generatedContent).add({
      schoolId: lesson.schoolId,
      lessonId: id,
      ...guide,
      ...(sections ? { sections } : {}),
      ...meta,
      tutorEdited: false,
      version: Date.now(),
      createdAt: Date.now(),
    });

    await adminDb.doc(`${JD.lessons}/${id}`).update({ status: "generated", updatedAt: Date.now() });
    await writeAuditLog({
      schoolId: session.schoolId,
      actorUid: session.uid,
      action: "lesson.generate",
      entityId: id,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    await adminDb.doc(`${JD.lessons}/${id}`).update({ status: "draft", updatedAt: Date.now() });

    if (err instanceof GenerationError && err.code === "RATE_LIMITED") {
      return NextResponse.json(
        {
          error:
            "The AI service is over its limit right now. Wait a few minutes and try again.",
        },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "We couldn't create study materials from this lesson. Try again." },
      { status: 502 }
    );
  }
}
