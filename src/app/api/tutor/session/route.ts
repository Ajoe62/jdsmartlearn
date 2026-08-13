import { NextResponse } from "next/server";
import { createTutorSession, clearTutorSession } from "@/lib/auth/tutor";
import type { ClaimRefusal } from "@/lib/auth/roles";

/**
 * What to tell someone whose password was right but whose account may not act.
 * Each says what happened and who fixes it, because none of them is something
 * the teacher can solve on this screen.
 */
const REFUSAL_MESSAGE: Record<ClaimRefusal, string> = {
  no_school:
    "Your account isn't linked to a school yet. Ask your administrator to finish setting it up.",
  inactive:
    "Your account is no longer active at this school. Ask your school administrator to restore it.",
  must_change_password:
    "You're still signing in with the temporary password. Change it in ResultPeak first, then sign in here.",
};

/** Exchange a Firebase ID token (from client sign-in) for a session cookie. */
export async function POST(req: Request) {
  const { idToken } = (await req.json()) as { idToken?: string };
  if (!idToken) {
    return NextResponse.json({ error: "Sign in again to continue." }, { status: 400 });
  }
  try {
    const refusal = await createTutorSession(idToken);
    if (refusal) {
      // 403, not 401: the credentials were correct. Retrying the password is
      // the one thing that cannot help here.
      return NextResponse.json({ error: REFUSAL_MESSAGE[refusal] }, { status: 403 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "That sign-in didn't work. Try again." }, { status: 401 });
  }
}

export async function DELETE() {
  await clearTutorSession();
  return NextResponse.json({ ok: true });
}
