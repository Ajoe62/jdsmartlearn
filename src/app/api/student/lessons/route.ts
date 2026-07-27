import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getStudyGuides } from "@/lib/db/student-content";
import { MAX_GUIDE_IDS } from "@/lib/offline/config";


/**
 * Study-guide bodies for specific lessons, so a device can download them in
 * small resumable batches instead of one large response.
 *
 *   GET /api/student/lessons?ids=abc,def
 *
 * Served from the same cached class bundle as /api/student/sync, so this costs
 * no extra Firestore reads. The bundle is built from lessons.studentPayload,
 * which is constructed by toStudentPayload and therefore cannot carry a marking
 * guide.
 */
export async function GET(req: Request) {
  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ error: "No lessons requested." }, { status: 400 });
  }
  if (ids.length > MAX_GUIDE_IDS) {
    return NextResponse.json(
      { error: `Ask for at most ${MAX_GUIDE_IDS} lessons at a time.` },
      { status: 400 }
    );
  }

  // Scoping is inside the bundle: ids from another class or school simply do not
  // appear in the result, so a guessed id reveals nothing.
  const lessons = await getStudyGuides(session.schoolId, session.classId, ids);

  return NextResponse.json(
    {
      lessons: lessons.map((l) => ({
        lessonId: l.lessonId,
        updatedAt: l.updatedAt,
        studyGuide: l.studyGuide,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
