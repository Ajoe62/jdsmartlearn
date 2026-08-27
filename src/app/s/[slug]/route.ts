import { NextResponse } from "next/server";
import { PINNED_COOKIE, SCHOOL_COOKIE, schoolCookieOptions } from "@/lib/auth/student";
import { findSchool } from "@/lib/db/resultpeak";

/**
 * The short link a school writes on the board: /s/capstone-academy.
 *
 * IT NO LONGER LANDS ON THE STUDENT FORM, and that was the bug. This route used
 * to redirect every visitor to /student/sign-in, so a teacher clicking the link
 * on their own school's website arrived at the child's sign-in - the one screen
 * in the product that offers "Change school". Staff never had a school picker;
 * they had a front door that did not exist. Now the link lands on "/", which
 * renders that school's own front door with a door for each audience.
 *
 * Two cookies, deliberately, because they answer different questions:
 *
 *   SCHOOL_COOKIE  which school did this phone last use     (also set by the picker)
 *   PINNED_COOKIE  did the SCHOOL ITSELF send this person   (only ever set here)
 *
 * Only the second suppresses the picker. See lib/auth/student.
 *
 * An unknown or ambiguous value falls through to the picker rather than failing
 * - a child mistyping a link should still land somewhere they can sign in.
 *
 * The cookies are set on the redirect response itself, so they survive the hop.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  // Accepts a slug OR a raw school id: a slug is recomputed from the school's
  // name on every read, so a school correcting a typo in its own name silently
  // breaks every link it has printed. See findSchool().
  const school = await findSchool(decodeURIComponent(slug));

  if (!school) {
    return NextResponse.redirect(new URL("/student/sign-in?school=change", req.url));
  }

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(SCHOOL_COOKIE, school.id, schoolCookieOptions());
  res.cookies.set(PINNED_COOKIE, school.id, schoolCookieOptions());
  return res;
}
