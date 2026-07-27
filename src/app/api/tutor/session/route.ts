import { NextResponse } from "next/server";
import { createTutorSession, clearTutorSession } from "@/lib/auth/tutor";

/** Exchange a Firebase ID token (from client sign-in) for a session cookie. */
export async function POST(req: Request) {
  const { idToken } = (await req.json()) as { idToken?: string };
  if (!idToken) {
    return NextResponse.json({ error: "Sign in again to continue." }, { status: 400 });
  }
  try {
    await createTutorSession(idToken);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "That sign-in didn't work. Try again." }, { status: 401 });
  }
}

export async function DELETE() {
  await clearTutorSession();
  return NextResponse.json({ ok: true });
}
