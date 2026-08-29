import { NextResponse } from "next/server";
import { refreshStudentSession, rememberSchool } from "@/lib/auth/student";
import { resolveHost } from "@/lib/routing/request-school";

/**
 * Re-authorize a device that has been offline and reissue its 12h session.
 *
 * This is what makes offline reading revocable. Saved lessons are readable from
 * IndexedDB with no live session, so the protection is not a short cookie - it is
 * that the first moment of connectivity re-checks the roster:
 *
 *  - 401 `revoked`  -> the student is deactivated or gone. Device wipes its store.
 *  - 200 `classChanged` -> moved class. Device wipes and re-syncs the new class.
 *  - 200            -> session extended, keep reading.
 *
 * Two Firestore reads per student per 12 hours.
 */
export async function POST() {
  const outcome = await refreshStudentSession();

  if (outcome.status === "revoked") {
    return NextResponse.json(
      { error: "Your account is no longer active. Ask your teacher.", wipe: true },
      { status: 401 }
    );
  }

  if (outcome.status === "no-token") {
    return NextResponse.json(
      { error: "Sign in again to read your lessons.", wipe: false },
      { status: 401 }
    );
  }

  /**
   * WHERE THE STALE SCHOOL COOKIE IS PHYSICALLY REPLACED.
   *
   * The hostname already beats the cookie everywhere it is read
   * (lib/routing/request-school.ts), so this changes no behaviour on its own -
   * it stops a year-old cookie for another school following the device back to
   * the shared domain, where no hostname resolves and the cookie is all there
   * is. This is the right place because a Server Component cannot set a cookie
   * in Next, and boot() already calls this route on every app open and every
   * reconnect: no new request, and no new sync mechanism.
   *
   * Written from the SESSION's school, not the hostname's. The hostname only
   * tells us the cookie is now suspect; what replaces it has to be the value
   * the server verified, or a stranger with a DNS record could repoint a child's
   * device by being visited once.
   */
  const host = await resolveHost();
  if (host.mode === "school" && host.schoolId !== outcome.session.schoolId) {
    await rememberSchool(outcome.session.schoolId);
  }

  return NextResponse.json({
    ok: true,
    studentId: outcome.session.studentId,
    classId: outcome.session.classId,
    // The device must drop the old class's lessons before re-syncing.
    wipe: outcome.classChanged,
  });
}
