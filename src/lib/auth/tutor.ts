import "server-only";
import { cookies } from "next/headers";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { RP } from "@/lib/db/collections";
import { isAdmin } from "@/lib/auth/roles";
import type { Claims, ResultPeakTutor } from "@/types";

export interface TutorSession {
  uid: string;
  schoolId: string;
  role: Claims["role"];
  /** Admin-level actor (school admin or superadmin) - see lib/auth/roles. */
  isAdmin: boolean;
  assignedClasses: string[];
}

const SESSION_COOKIE = "jd_tutor";

/** Exchange a Firebase ID token for a session cookie (5 days). */
export async function createTutorSession(idToken: string): Promise<void> {
  const expiresIn = 5 * 24 * 60 * 60 * 1000;
  const sessionCookie = await adminAuth.createSessionCookie(idToken, { expiresIn });
  (await cookies()).set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: expiresIn / 1000,
    path: "/",
  });
}

/**
 * Resolve the current tutor. Claims are read from the token (zero Firestore
 * reads); assignedClasses comes from ResultPeak's tutor profile.
 *
 * Multi-school accounts (ResultPeak's `schoolIds` claim): a person can be an
 * admin at one school and a tutor at another under one Auth account. The
 * session's school is wherever their TUTOR PROFILE lives (claim school
 * checked first, so single-school accounts cost one read as before). Admin
 * powers apply ONLY in the school they administer (`claims.schoolId`) - being
 * an admin elsewhere grants nothing here.
 */
export async function getTutorSession(): Promise<TutorSession | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) return null;

  try {
    const decoded = await adminAuth.verifySessionCookie(cookie, true);
    const claims = decoded as unknown as Claims & { uid: string };
    if (!claims.schoolId || claims.active === false) return null;

    const candidateSchools = [
      claims.schoolId,
      ...(claims.schoolIds ?? []).filter((s) => s !== claims.schoolId),
    ];

    let schoolId = claims.schoolId;
    let profile: ResultPeakTutor | undefined;
    for (const sid of candidateSchools) {
      const snap = await adminDb.doc(`${RP.tutors(sid)}/${decoded.uid}`).get();
      if (snap.exists) {
        schoolId = sid;
        profile = snap.data() as ResultPeakTutor;
        break;
      }
    }

    return {
      uid: decoded.uid,
      schoolId,
      role: claims.role ?? "tutor",
      isAdmin: isAdmin(claims) && schoolId === claims.schoolId,
      // Admins are not restricted to assignedClasses.
      assignedClasses: profile?.assignedClasses ?? [],
    };
  } catch {
    return null;
  }
}

/** Throws unless the tutor may act on this class. Call in EVERY route. */
export function assertClassAccess(session: TutorSession, classId: string): void {
  if (session.isAdmin) return;
  if (!session.assignedClasses.includes(classId)) {
    throw new Error("FORBIDDEN: class not assigned to this tutor");
  }
}

export async function clearTutorSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
