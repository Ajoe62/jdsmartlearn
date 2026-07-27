import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getStudentMaterial } from "@/lib/db/student-content";

/**
 * Published material text for one lesson, so a device can save it for offline
 * reading.
 *
 * Kept out of the sync bundle deliberately: extractedText runs to 800 KB, and
 * 200 of them would exhaust the function's memory. Cached per lesson, so a whole
 * class opening the same lesson costs one read per revalidate window.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  // Returns null for another class's lesson, or one whose material is unpublished.
  const material = await getStudentMaterial(session.schoolId, session.classId, id);
  if (!material) {
    return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
  }

  return NextResponse.json(
    { lessonId: id, text: material.text, revision: material.revision },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
