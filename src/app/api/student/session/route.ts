import { NextResponse } from "next/server";
import {
  verifyStudentCode,
  createStudentSession,
  clearStudentSession,
} from "@/lib/auth/student";
import { isThrottled, recordFailure, recordSuccess } from "@/lib/auth/throttle";

/** Student sign-in: student id + access code, verified server-side only. */
export async function POST(req: Request) {
  const { studentId, code } = (await req.json()) as { studentId?: string; code?: string };

  if (!studentId || !code) {
    return NextResponse.json({ error: "Enter your student ID and code." }, { status: 400 });
  }

  // Throttle by student id AND by caller IP, so guessing codes for one student
  // or cycling students from one machine both hit a wall.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const keys = [`sid:${studentId.trim()}`, `ip:${ip}`];
  if (keys.some(isThrottled)) {
    return NextResponse.json(
      { error: "Too many attempts. Wait 15 minutes and try again." },
      { status: 429 }
    );
  }

  const session = await verifyStudentCode(studentId.trim(), code.trim());
  if (!session) {
    keys.forEach(recordFailure);
    // Deliberately vague: do not reveal which part was wrong.
    return NextResponse.json({ error: "That ID and code don't match." }, { status: 401 });
  }

  keys.forEach(recordSuccess);
  await createStudentSession(session);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await clearStudentSession();
  return NextResponse.json({ ok: true });
}
