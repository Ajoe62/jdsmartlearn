import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getClassSyncIndex } from "@/lib/db/student-content";

/**
 * How long a device may keep reading saved lessons after this sync. Read here,
 * server-side, and sent to the device rather than exposed as a NEXT_PUBLIC_ var.
 * Capped at 30 days: a window longer than the refresh cookie's life would let a
 * device outlive any possibility of revocation.
 */
function offlineGraceDays(): number {
  const raw = Number(process.env.STUDENT_OFFLINE_GRACE_DAYS ?? 7);
  if (!Number.isFinite(raw) || raw < 0) return 7;
  return Math.min(raw, 30);
}

/**
 * The sync index: every lesson this student's class may read, without the
 * study-guide bodies. ~150 bytes per lesson, so ~30 KB at the 200-lesson cap -
 * one small response that completes on a bad link.
 *
 * Costs no Firestore reads of its own: it slices getClassSyncBundle, which is
 * cached per class. Thirty students syncing at 8am share ONE query.
 *
 * ETag'd, so the common case (nothing published since yesterday) is a 304.
 */
export async function GET(req: Request) {
  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const lessons = await getClassSyncIndex(session.schoolId, session.classId);

  const body = {
    studentId: session.studentId,
    classId: session.classId,
    graceDays: offlineGraceDays(),
    lessons,
  };

  // Hash the payload, not the request - the device only needs to know whether
  // anything it would store has changed.
  const json = JSON.stringify(body);
  const etag = `"${createHash("sha1").update(json).digest("base64url")}"`;

  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, no-store" },
    });
  }

  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      // The device store is IndexedDB, not the HTTP cache. Never let a shared
      // proxy hold a class's lesson list.
      "Cache-Control": "private, no-store",
    },
  });
}
