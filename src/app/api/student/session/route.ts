import { NextResponse } from "next/server";
import {
  resolveStudentIdentifier,
  verifyStudentCode,
  createStudentSession,
  clearStudentSession,
  rememberSchool,
} from "@/lib/auth/student";
import { isThrottled, recordFailure, recordSuccess } from "@/lib/auth/throttle";

/**
 * Student sign-in: school + username + access code, verified server-side only.
 *
 * `username` is a JDSmartLearn alias (`jss3-04`); a raw ResultPeak student id
 * still resolves, so sign-ins issued before usernames existed keep working.
 * The access code is always ResultPeak's - we never mint a second credential.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    schoolId?: string;
    username?: string;
    /** Pre-username clients. */
    studentId?: string;
    code?: string;
  };

  const schoolId = body.schoolId?.trim() || null;
  const identifier = (body.username ?? body.studentId ?? "").trim();
  const code = body.code?.trim();

  if (!identifier || !code) {
    return NextResponse.json({ error: "Enter your username and code." }, { status: 400 });
  }

  // Throttle by what was typed AND by caller IP, so guessing codes for one
  // student or cycling students from one machine both hit a wall.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const keys = [`id:${schoolId ?? "-"}:${identifier.toLowerCase()}`, `ip:${ip}`];
  if (keys.some(isThrottled)) {
    return NextResponse.json(
      { error: "Too many attempts. Wait 15 minutes and try again." },
      { status: 429 }
    );
  }

  // Deliberately vague on every failure: do not reveal which part was wrong.
  const reject = () => {
    keys.forEach(recordFailure);
    return NextResponse.json(
      { error: "That username and code don't match." },
      { status: 401 }
    );
  };

  const studentId = await resolveStudentIdentifier(schoolId, identifier);
  if (!studentId) return reject();

  const session = await verifyStudentCode(studentId, code);
  if (!session) return reject();

  // A legacy student id carries its own school. If the device picked one, it
  // must agree - otherwise an id from another school would sign in here.
  if (schoolId && session.schoolId !== schoolId) return reject();

  keys.forEach(recordSuccess);
  await createStudentSession(session);

  // Remember the SCHOOL on this phone so the next child skips the picker.
  // Never the username: phones are shared, and it would grant nothing anyway.
  await rememberSchool(session.schoolId);

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await clearStudentSession();
  return NextResponse.json({ ok: true });
}
