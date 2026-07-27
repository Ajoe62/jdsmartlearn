import { NextResponse } from "next/server";
import { getTutorSession } from "@/lib/auth/tutor";
import { createCustomTopic } from "@/lib/db/topics";
import { writeAuditLog } from "@/lib/db/lessons";
import { getSubjects } from "@/lib/db/resultpeak";
import type { ClassLevel, Term } from "@/types";

const LEVELS: readonly string[] = [
  "P1", "P2", "P3", "P4", "P5", "P6",
  "JSS1", "JSS2", "JSS3",
  "SS1", "SS2", "SS3",
];

/** Create a tutor's own topic when the seeded curriculum has no match. */
export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    subjectId?: string;
    level?: string;
    term?: number;
    title?: string;
  };

  const title = (body.title ?? "").trim();
  if (title.length < 3 || title.length > 120) {
    return NextResponse.json(
      { error: "Give the topic a title (3–120 characters)." },
      { status: 400 }
    );
  }
  if (!body.level || !LEVELS.includes(body.level)) {
    return NextResponse.json({ error: "Choose a class level." }, { status: 400 });
  }
  if (body.term !== 1 && body.term !== 2 && body.term !== 3) {
    return NextResponse.json({ error: "Choose a term." }, { status: 400 });
  }

  // Subject must be one of the school's real subjects (ResultPeak's list).
  const subjects = await getSubjects(session.schoolId);
  if (!body.subjectId || !subjects.some((s) => s.id === body.subjectId)) {
    return NextResponse.json({ error: "Choose a subject." }, { status: 400 });
  }

  const topic = await createCustomTopic({
    schoolId: session.schoolId,
    subjectId: body.subjectId,
    level: body.level as ClassLevel,
    term: body.term as Term,
    title,
  });

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "topic.create",
    entityId: topic.id,
  });

  return NextResponse.json({ topic });
}
