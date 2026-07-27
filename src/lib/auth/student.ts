import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { adminDb } from "@/lib/firebase/admin";
import { RP } from "@/lib/db/collections";
import { resolveUsername } from "@/lib/db/student-logins";
import { safeEqual } from "./compare";
import type { ResultPeakStudent } from "@/types";

/**
 * Students have no Firebase Auth account - same as ResultPeak's exam entry.
 * They present school + student id + access code; we verify against
 * studentAccess/{studentId} SERVER-SIDE and issue our own signed cookie.
 * The access code is never sent to the client and studentAccess is never
 * exposed through a public read rule.
 */

const COOKIE = "jd_student";
/**
 * Long-lived companion cookie holding only the studentId. It buys the right to
 * ASK for a new 12h session; every refresh re-reads Firestore, so it grants
 * nothing on its own. Without it, a device that has been offline for a day would
 * have to re-enter the access code before it could re-authorize - and re-authorizing
 * on reconnect is what makes offline reading revocable.
 */
const REFRESH_COOKIE = "jd_student_r";
/**
 * Which school this phone belongs to. Not a credential - it only skips the
 * picker, because a username like `jss3-04` is unique per school. Survives
 * sign-out on purpose: the next child at the same school shouldn't pick again.
 * The username is deliberately NOT remembered - phones are shared.
 */
export const SCHOOL_COOKIE = "jd_school";

export const schoolCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 365 * 24 * 60 * 60,
});
const secret = () => new TextEncoder().encode(process.env.STUDENT_SESSION_SECRET!);

const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Matches the offline grace window - a device past it must sign in again anyway. */
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface StudentSession {
  studentId: string;
  schoolId: string;
  classId: string;
}

/** Why a refresh failed, so the caller knows whether to wipe the device store. */
export type RefreshOutcome =
  | { status: "ok"; session: StudentSession; classChanged: boolean }
  | { status: "revoked" }
  | { status: "no-token" };

/**
 * Turn what a student typed into a studentId.
 *
 * Students sign in with a username their teacher gave them (`jss3-04`), which
 * is a JDSmartLearn alias for the ResultPeak document id. The raw document id
 * still works: it is what everyone used before usernames existed, and a school
 * mid-rollout will have both in circulation.
 *
 * Resolution only - it proves nothing. The access code is still checked by
 * verifyStudentCode, and the school is re-asserted by the caller.
 */
export async function resolveStudentIdentifier(
  schoolId: string | null,
  identifier: string
): Promise<string | null> {
  const typed = identifier.trim();
  if (!typed) return null;

  if (schoolId) {
    const byUsername = await resolveUsername(schoolId, typed);
    if (byUsername) return byUsername;
  }

  // Legacy: the input may be a raw student document id. Reject anything that
  // isn't a legal one - `a/b` would build a malformed path and throw.
  if (typed.includes("/") || typed === "." || typed === ".." || typed.length > 200) return null;
  return typed;
}

export async function verifyStudentCode(
  studentId: string,
  code: string
): Promise<StudentSession | null> {
  const accessSnap = await adminDb.doc(`${RP.studentAccess}/${studentId}`).get();
  if (!accessSnap.exists) return null;

  const access = accessSnap.data() as { code?: string; schoolId?: string };
  if (!access.code || !safeEqual(access.code, code)) return null;

  const studentSnap = await adminDb.doc(`${RP.students}/${studentId}`).get();
  const student = studentSnap.data() as ResultPeakStudent | undefined;
  if (!student || student.isActive === false) return null;

  return { studentId, schoolId: student.schoolId, classId: student.classId };
}

export async function createStudentSession(s: StudentSession): Promise<void> {
  const jar = await cookies();
  const common = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };

  const token = await new SignJWT({ ...s })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());

  jar.set(COOKIE, token, { ...common, maxAge: SESSION_TTL_SECONDS });

  const refresh = await new SignJWT({ studentId: s.studentId, kind: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());

  jar.set(REFRESH_COOKIE, refresh, { ...common, maxAge: REFRESH_TTL_SECONDS });
}

/**
 * Re-authorize a device against Firestore and reissue its 12h session.
 *
 * This is the revocation point for offline reading. Cached lessons are readable
 * without a live session, so the guarantee is not "the session is short" - it is
 * "the first moment of connectivity re-checks the roster". A deactivated student
 * is revoked here; a student moved to another class gets a session for the new
 * class and a `classChanged` flag so the caller wipes the old class's content.
 *
 * Two document reads per student per 12 hours.
 */
export async function refreshStudentSession(): Promise<RefreshOutcome> {
  const jar = await cookies();
  const raw = jar.get(REFRESH_COOKIE)?.value;
  if (!raw) return { status: "no-token" };

  let studentId: string;
  try {
    const { payload } = await jwtVerify(raw, secret());
    if (payload.kind !== "refresh" || typeof payload.studentId !== "string") {
      return { status: "no-token" };
    }
    studentId = payload.studentId;
  } catch {
    return { status: "no-token" };
  }

  const snap = await adminDb.doc(`${RP.students}/${studentId}`).get();
  const student = snap.data() as ResultPeakStudent | undefined;

  // Deactivated, deleted, or missing a class: revoke and let the caller wipe.
  if (!student || student.isActive === false || !student.classId || !student.schoolId) {
    jar.delete(COOKIE);
    jar.delete(REFRESH_COOKIE);
    return { status: "revoked" };
  }

  const previous = await getStudentSession();
  const classChanged = !!previous && previous.classId !== student.classId;

  const session: StudentSession = {
    studentId,
    schoolId: student.schoolId,
    classId: student.classId,
  };
  await createStudentSession(session);

  return { status: "ok", session, classChanged };
}

export async function rememberSchool(schoolId: string): Promise<void> {
  (await cookies()).set(SCHOOL_COOKIE, schoolId, schoolCookieOptions());
}

export async function getRememberedSchoolId(): Promise<string | null> {
  return (await cookies()).get(SCHOOL_COOKIE)?.value ?? null;
}

export async function forgetSchool(): Promise<void> {
  (await cookies()).delete(SCHOOL_COOKIE);
}

export async function clearStudentSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(REFRESH_COOKIE);
}

export async function getStudentSession(): Promise<StudentSession | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      studentId: String(payload.studentId),
      schoolId: String(payload.schoolId),
      classId: String(payload.classId),
    };
  } catch {
    return null;
  }
}
