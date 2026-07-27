import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getClassesByIds, getStudentsInClass } from "@/lib/db/resultpeak";
import { assignClassLogins, accessCodesFor } from "@/lib/db/student-logins";
import { writeAuditLog } from "@/lib/db/lessons";

/**
 * Create sign-in usernames for a class.
 *
 * Writes ONLY to studentLogins (JDSmartLearn-owned). Everything about the
 * students themselves - the roster, the access codes, who is active - stays in
 * ResultPeak and is only read here.
 *
 * Idempotent: students who already have a username keep it, so a teacher can
 * press the button again after a new pupil joins.
 */
export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });

  const { classId } = (await req.json()) as { classId?: string };
  if (!classId) {
    return NextResponse.json({ error: "Choose a class first." }, { status: 400 });
  }

  try {
    assertClassAccess(session, classId);
  } catch {
    return NextResponse.json({ error: "You don't teach that class." }, { status: 403 });
  }

  const [cls] = await getClassesByIds([classId]);
  if (!cls || cls.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "That class isn't available." }, { status: 400 });
  }

  const students = await getStudentsInClass(session.schoolId, classId);
  const active = students.filter((s) => s.isActive !== false);

  // A username is useless without an access code, and skipping the rest also
  // leaves out the duplicate roster-only records that exist in ResultPeak.
  const withCode = await accessCodesFor(active.map((s) => s.id));
  const eligible = active
    .filter((s) => withCode.has(s.id))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  if (!eligible.length) {
    return NextResponse.json(
      {
        error:
          "No one in this class has an access code yet. Ask your school admin to issue them in ResultPeak.",
      },
      { status: 400 }
    );
  }

  const assigned = await assignClassLogins(
    session.schoolId,
    cls.name,
    eligible.map((s) => s.id)
  );

  if (assigned.length) {
    await writeAuditLog({
      schoolId: session.schoolId,
      actorUid: session.uid,
      action: "student.logins.create",
      entityId: classId,
      detail: `${assigned.length} username(s)`,
    });
  }

  revalidatePath("/tutor/sign-ins");
  return NextResponse.json({ created: assigned.length });
}
