import { NextResponse } from "next/server";
import { refreshStudentSession } from "@/lib/auth/student";

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

  return NextResponse.json({
    ok: true,
    studentId: outcome.session.studentId,
    classId: outcome.session.classId,
    // The device must drop the old class's lessons before re-syncing.
    wipe: outcome.classChanged,
  });
}
