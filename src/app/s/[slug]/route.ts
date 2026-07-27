import { NextResponse } from "next/server";
import { SCHOOL_COOKIE, schoolCookieOptions } from "@/lib/auth/student";
import { findSchoolBySlug } from "@/lib/db/resultpeak";

/**
 * The short link a school writes on the board: /s/capstone-academy.
 *
 * Remembers the school on this phone and sends the student to sign-in, so all
 * they type is their username and code. An unknown or ambiguous slug falls
 * through to the picker rather than failing - a child mistyping a link should
 * still land somewhere they can sign in.
 *
 * The cookie is set on the redirect response itself, so it survives the hop.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const school = await findSchoolBySlug(slug.toLowerCase());

  const res = NextResponse.redirect(
    new URL(school ? "/student/sign-in" : "/student/sign-in?school=change", req.url)
  );
  if (school) res.cookies.set(SCHOOL_COOKIE, school.id, schoolCookieOptions());
  return res;
}
