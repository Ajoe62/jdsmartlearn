import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "@/lib/db/collections";
import { assertWritable } from "@/lib/db/write-guard";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getLesson, countGenerationsToday, writeAuditLog } from "@/lib/db/lessons";
import { getSubjects } from "@/lib/db/resultpeak";
import { generateStudyMaterials } from "@/lib/ai/provider";
import { GenerationError } from "@/lib/ai/errors";
import type { ClassLevel, Topic } from "@/types";

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
  } catch {
    return NextResponse.json({ error: "You don't teach that class." }, { status: 403 });
  }

  const cap = Number(process.env.MAX_GENERATIONS_PER_TUTOR_PER_DAY ?? 20);
  if ((await countGenerationsToday(session.schoolId, session.uid)) >= cap) {
    return NextResponse.json(
      { error: `You've reached today's limit of ${cap} generations. Try again tomorrow.` },
      { status: 429 }
    );
  }

  const topicSnap = await adminDb.doc(`${JD.topics}/${lesson.topicId}`).get();
  const topic = topicSnap.data() as Topic | undefined;
  const subjects = await getSubjects(session.schoolId);
  const subjectName =
    subjects.find((s) => s.id === lesson.subjectId)?.name ?? lesson.subjectId;

  await adminDb.doc(`${JD.lessons}/${id}`).update({ status: "generating", updatedAt: Date.now() });

  try {
    // Payload carries lesson content only - no names, no ids. See CLAUDE.md.
    const { result, meta } = await generateStudyMaterials({
      lessonText: lesson.extractedText,
      subjectName,
      topicTitle: topic?.title ?? lesson.title,
      level: (topic?.level ?? "SS2") as ClassLevel,
    });

    assertWritable(JD.generatedContent);
    await adminDb.collection(JD.generatedContent).add({
      schoolId: lesson.schoolId,
      lessonId: id,
      ...result,
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
