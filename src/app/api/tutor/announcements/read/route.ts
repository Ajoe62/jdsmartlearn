import { NextResponse } from "next/server";
import { getTutorSession } from "@/lib/auth/tutor";
import { getNoticesForTutor } from "@/lib/db/announcements";
import { recordRead } from "@/lib/db/read-state";
import { visibleToTutor } from "@/lib/announcements/notices";

/**
 * A tutor dismissed one or more announcements.
 *
 * The student twin of this route lives at /api/student/announcements/read and
 * works identically. Two routes rather than one that branches on session type:
 * the two sessions are established by completely different mechanisms (a
 * Firebase ID token behind a 5-day cookie, versus a server-minted student
 * session), and a single route would have to decide which of them it trusted
 * before it knew who was calling.
 */

const MAX_IDS = 50;

export async function POST(req: Request) {
  const session = await getTutorSession();
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

  const candidates = await getNoticesForTutor(session.schoolId, session.uid);
  const visible = visibleToTutor(
    candidates,
    session.uid,
    session.assignedClasses,
    Date.now()
  );

  const allowed = new Set(visible.map((n) => n.id));
  const accepted = ids.filter((id) => allowed.has(id));

  const state = await recordRead(
    session.schoolId,
    session.uid,
    "tutor",
    visible,
    accepted
  );

  return NextResponse.json(
    { seenAt: state.seenAt, readIds: state.readIds },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
