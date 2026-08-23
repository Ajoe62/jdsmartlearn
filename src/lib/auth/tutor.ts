import "server-only";
import { cookies } from "next/headers";
import { adminAuth, adminDb } from "@/lib/firebase/admin";
import { RP } from "@/lib/db/collections";
import { getSubjectAllocationEnforced } from "@/lib/db/resultpeak";
import { claimRefusal, isAdmin } from "@/lib/auth/roles";
import { teachesSubject, teachesSubjectInClass } from "@/lib/auth/subject-access";
import type { ClaimRefusal } from "@/lib/auth/roles";
import type { Claims, ResultPeakTutor } from "@/types";

export interface TutorSession {
  uid: string;
  schoolId: string;
  role: Claims["role"];
  /** Admin-level actor (school admin or superadmin) - see lib/auth/roles. */
  isAdmin: boolean;
  assignedClasses: string[];

  /**
   * Display name from the same ResultPeak profile read, so it costs nothing.
   *
   * Empty string when absent, which is normal: a school admin has no
   * `schools/{id}/tutors/{uid}` document at all. Used only to sign an
   * announcement ("From Mrs Adeyemi"); every reader-facing fallback is in
   * `toNoticeItem()`, which never shows a uid.
   */
  name: string;

  /**
   * Subject allocation, from the same profile read as assignedClasses.
   *
   * Empty on both means the tutor has not been allocated yet, which means every
   * subject - see isUnallocated() in lib/auth/subject-access.
   *
   * ResultPeak's authoritative `assignments` array is deliberately NOT carried
   * here. These two derived fields are what every check reads, and holding the
   * authoritative one alongside them invites a future check to read that
   * instead and reintroduce exactly the divergence isUnallocated() guards.
   */
  assignedSubjects: string[];
  /** subjectId -> classIds. */
  subjectClasses: Record<string, string[]>;

  /**
   * The SCHOOL's enforcement flag, not a property of this tutor.
   *
   * Absent means off, so this is false for every school today. It is what turns
   * the two fields above from a picker convenience into an authorization check -
   * see the truth table in lib/auth/subject-access. Carried on the session so
   * the pure module gets one object with everything it needs; costs one cached
   * read per school per minute, never a read per request.
   */
  subjectAllocationEnforced: boolean;
}

const SESSION_COOKIE = "jd_tutor";

/**
 * Exchange a Firebase ID token for a session cookie (5 days).
 *
 * Returns a refusal instead of minting the cookie when the claims are not fit
 * to act. Refusing HERE as well as in getTutorSession() is what keeps a refused
 * account off the sign-in bounce: every tutor page redirects to /tutor/sign-in
 * on a null session, so an account that could sign in but not resolve a session
 * would land back on the form with no idea why, forever.
 */
export async function createTutorSession(idToken: string): Promise<ClaimRefusal | null> {
  const expiresIn = 5 * 24 * 60 * 60 * 1000;

  // checkRevoked so a token minted before a deactivation cannot be traded in.
  const decoded = await adminAuth.verifyIdToken(idToken, true);
  const refusal = claimRefusal(decoded as unknown as Partial<Claims>);
  if (refusal) return refusal;

  const sessionCookie = await adminAuth.createSessionCookie(idToken, { expiresIn });
  (await cookies()).set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: expiresIn / 1000,
    path: "/",
  });
  return null;
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
    // Same predicate as the exchange above, applied again on every request.
    //
    // The claims in a session cookie are frozen at creation, so this does NOT
    // see a change made since; `checkRevoked` above is what catches that, and
    // it works because ResultPeak calls revokeRefreshTokens() on every claim
    // change that matters (deactivation, password reset, school purge).
    // Checking here still matters for the cookies already in the wild: a 5-day
    // cookie minted before this check existed carries mustChangePassword and
    // would otherwise keep working until it expired.
    if (claimRefusal(claims)) return null;

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

    /**
     * Read AFTER the loop above, because that loop is what resolves which school
     * this tutor actually belongs to when their claims name more than one.
     * Reading it against `claims.schoolId` would check the wrong school's flag
     * for exactly the multi-school accounts the loop exists to handle.
     *
     * Cached for 60s per school, so this is not a per-request read.
     */
    const subjectAllocationEnforced = await getSubjectAllocationEnforced(schoolId);

    return {
      uid: decoded.uid,
      schoolId,
      role: claims.role ?? "tutor",
      isAdmin: isAdmin(claims) && schoolId === claims.schoolId,
      // Admins are not restricted to assignedClasses.
      assignedClasses: profile?.assignedClasses ?? [],
      name: profile?.name ?? "",
      // Same profile read, no extra Firestore cost. Absent on a tutor ResultPeak
      // has not allocated yet - which means "every subject" while the school
      // flag below is off, and "no subject" once it is on.
      assignedSubjects: profile?.assignedSubjects ?? [],
      subjectClasses: profile?.subjectClasses ?? {},
      subjectAllocationEnforced,
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

/**
 * Throws unless the tutor teaches this SUBJECT in this CLASS.
 *
 * Always call assertClassAccess first - this narrows that check, it does not
 * replace it. An unallocated tutor passes, which is what keeps every account
 * working until ResultPeak has allocated them.
 */
export function assertSubjectAccess(
  session: TutorSession,
  classId: string,
  subjectId: string
): void {
  if (!teachesSubjectInClass(session, classId, subjectId)) {
    throw new Error("FORBIDDEN: subject not assigned to this tutor for this class");
  }
}

/**
 * Throws unless the tutor teaches this subject somewhere. For POST /api/topics,
 * which creates a school-wide curriculum row and has no class to check against.
 */
export function assertSubjectTaught(session: TutorSession, subjectId: string): void {
  if (!teachesSubject(session, subjectId)) {
    throw new Error("FORBIDDEN: subject not assigned to this tutor");
  }
}

/**
 * Whether this tutor may act on a stored document.
 *
 * The author always passes. Lessons and assignments created BEFORE allocation
 * carry whatever subject the then-unfiltered picker offered, so a strict subject
 * check would 404 a teacher out of their own work - a lesson still listed on
 * their own dashboard. It also matches the Firestore rules, which already scope
 * tutor reads to `tutorId == request.auth.uid`.
 *
 * THE BYPASS SURVIVES ENFORCEMENT, by an explicit decision. Switching the school
 * flag on does not re-scope documents a tutor already wrote: they keep access to
 * their own work whatever subject it carries. The alternative - re-checking
 * authored documents against the new allocation - would strand a teacher's own
 * lessons behind a 404 on the day their school turned the flag on, which is the
 * worst possible moment to discover an allocation is wrong. Enforcement governs
 * what a tutor may CREATE next, not what they wrote before.
 *
 * What this still closes: a colleague teaching a DIFFERENT subject in the same
 * class can no longer open the document and read its marking guide.
 */
export function assertDocumentSubjectAccess(
  session: TutorSession,
  doc: { tutorId: string; classId: string; subjectId: string }
): void {
  if (doc.tutorId === session.uid) return;
  assertSubjectAccess(session, doc.classId, doc.subjectId);
}

export async function clearTutorSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
