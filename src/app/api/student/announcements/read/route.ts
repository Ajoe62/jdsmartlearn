import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getNoticesForClass } from "@/lib/db/announcements";
import { recordRead } from "@/lib/db/read-state";
import { visibleToStudent } from "@/lib/announcements/notices";

/**
 * A student dismissed one or more announcements.
 *
 * ONE WRITE, to one document keyed to this reader. Nothing here writes the
 * notice itself: a per-reader delivery record on a shared document would be a
 * write per child per notice, and CLAUDE.md's "never a channel" rule refuses
 * showing an author who has read what anyway.
 *
 * The candidate set is re-read server-side rather than trusted from the body.
 * The device sends ids; what those ids are, when they were created, and whether
 * this student may see them at all is decided here. It costs no Firestore reads
 * of its own - getNoticesForClass is the same cached bundle the dashboard and
 * the sync route already share.
 */

const MAX_IDS = 50;

export async function POST(req: Request) {
  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = raw
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, MAX_IDS);

  if (ids.length === 0) {
    return NextResponse.json({ error: "Nothing to mark as read." }, { status: 400 });
  }

  const candidates = await getNoticesForClass(session.schoolId, session.classId);
  const visible = visibleToStudent(candidates, session.classId, Date.now());

  /**
   * Drop ids this student cannot see.
   *
   * Not a security hole if it were left in - a read state holds no content - but
   * it keeps another class's notice ids out of a document that is capped, where
   * junk would push out real dismissals and make notices reappear.
   */
  const allowed = new Set(visible.map((n) => n.id));
  const accepted = ids.filter((id) => allowed.has(id));

  const state = await recordRead(
    session.schoolId,
    session.studentId,
    "student",
    visible,
    accepted
  );

  return NextResponse.json(
    { seenAt: state.seenAt, readIds: state.readIds },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
