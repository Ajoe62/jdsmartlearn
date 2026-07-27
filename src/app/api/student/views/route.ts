import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { recordLessonViewBatch } from "@/lib/db/lesson-views";
import { getClassSyncIndex } from "@/lib/db/student-content";
import { MAX_VIEW_RECEIPTS } from "@/lib/offline/config";

/**
 * Flush read receipts queued on a device.
 *
 * Replaces the old one-write-per-page-render behaviour: a device dedupes to one
 * receipt per lesson per UTC day and sends them in a single batch on reconnect.
 *
 * The batchId makes a retry after a lost response safe - see
 * recordLessonViewBatch.
 */
export async function POST(req: Request) {
  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    batchId?: string;
    views?: { lessonId?: string; count?: number }[];
  };

  if (!body.batchId || typeof body.batchId !== "string" || body.batchId.length > 64) {
    return NextResponse.json({ error: "Missing batch id." }, { status: 400 });
  }
  if (!Array.isArray(body.views) || body.views.length === 0) {
    return NextResponse.json({ error: "No receipts sent." }, { status: 400 });
  }
  if (body.views.length > MAX_VIEW_RECEIPTS) {
    return NextResponse.json(
      { error: `Send at most ${MAX_VIEW_RECEIPTS} receipts at a time.` },
      { status: 400 }
    );
  }

  /**
   * A device could claim a view on any lesson id. Accept only lessons this class
   * can actually see, so a receipt can never create a doc scoped to a lesson the
   * student has no access to. Free - this reads the cached class bundle.
   */
  const visible = new Set(
    (await getClassSyncIndex(session.schoolId, session.classId)).map((l) => l.lessonId)
  );

  const views: { lessonId: string; count: number }[] = [];
  for (const v of body.views) {
    if (typeof v.lessonId !== "string" || !visible.has(v.lessonId)) continue;
    const count = Number(v.count);
    if (!Number.isInteger(count) || count < 1) continue;
    // A day's worth of re-reading, capped so a tampered payload can't inflate.
    views.push({ lessonId: v.lessonId, count: Math.min(count, 50) });
  }

  if (views.length === 0) {
    // Nothing usable, but the device should still clear its queue.
    return NextResponse.json({ ok: true, applied: 0, skipped: 0 });
  }

  const result = await recordLessonViewBatch({
    schoolId: session.schoolId,
    classId: session.classId,
    studentId: session.studentId,
    batchId: body.batchId,
    views,
  });

  return NextResponse.json({ ok: true, ...result });
}
