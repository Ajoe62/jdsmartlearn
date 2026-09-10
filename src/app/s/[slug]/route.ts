import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PINNED_COOKIE, SCHOOL_COOKIE, schoolCookieOptions } from "@/lib/auth/student";
import { findSchool } from "@/lib/db/resultpeak";
import { primaryAddress } from "@/lib/db/school-domains";
import { isPlatformHost, normaliseHostname, platformConfig } from "@/lib/routing/hostname";

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

/**
 * Where `?next=` may point. AN EXACT-MATCH SET, never a prefix test.
 *
 * This value arrives in a URL anybody can write, and it ends up in a redirect,
 * so the only safe shape is membership of a list written here. A prefix rule
 * lets `//evil.example` and `/tutor/../../x` through; an exact set cannot.
 *
 * It exists so ResultPeak's STAFF links can name a school. Their student card
 * already links to /s/{slug}, which is why a child gets a branded sign-in and a
 * teacher does not: the staff links go to /tutor carrying no school at all. With
 * this, /s/{slug}?next=/tutor brands the teacher's door too, and the school is
 * still resolved here rather than trusted from the query.
 */
const NEXT_PATHS = new Set(["/", "/tutor", "/tutor/sign-in", "/student", "/student/sign-in"]);

/** Session cookies, by presence only - see the note in GET. */
const SESSION_COOKIES = ["jd_student", "jd_student_r", "jd_tutor"];

function nextPath(url: URL): string {
  const requested = url.searchParams.get("next") ?? "";
  return NEXT_PATHS.has(requested) ? requested : "/";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const url = new URL(req.url);
  const target = nextPath(url);

  // Accepts a slug OR a raw school id: a slug is recomputed from the school's
  // name on every read, so a school correcting a typo in its own name silently
  // breaks every link it has printed. See findSchool().
  const school = await findSchool(decodeURIComponent(slug));

  if (!school) {
    return NextResponse.redirect(new URL("/student/sign-in?school=change", req.url));
  }

  /**
   * ============================================================================
   * A SCHOOL WITH ITS OWN ADDRESS IS SENT TO IT, RATHER THAN BRANDED BY COOKIE.
   * ============================================================================
   *
   * ResultPeak's "Open JDSmartLearn" links resolve to the shared deployment
   * whenever a school's `schoolBranding.lessonsUrl` is unset - which it is for
   * every school today, including one whose real address is already registered
   * in `schoolDomains`. The visitor lands on the platform host, where there is
   * no hostname to resolve a school from, and gets the plain product door
   * instead of their school's crest.
   *
   * The fix on that side is `docs/resultpeak-partner-origin-prompt.md`. This is
   * the half that does not wait for it, and it also recovers a printed link or a
   * bookmark that names the shared deployment - neither of which that fix can
   * reach.
   *
   * Forwarding, rather than setting the cookies here, is what makes it work:
   * the destination resolves the school FROM ITS OWN HOSTNAME, which beats the
   * cookie, pins the device and needs nothing carried across. Cookies are
   * host-scoped, so any set on this side would not survive the hop anyway.
   *
   * Three guards, each load-bearing:
   *
   *   NEVER A SIGNED-IN VISITOR. A cross-origin hop silently drops their
   *   session and would make them sign in again to reach the same content.
   *   Presence of the cookie is enough and it is deliberately not verified: this
   *   decides whether to be helpful, not whether to grant anything, and a
   *   Firestore read or a JWT verify on every link click would be a real cost
   *   for a question that does not need the right answer, only the safe one.
   *
   *   NEVER OFF A SCHOOL'S OWN HOST. Only a platform host forwards, so the
   *   destination cannot forward again and there is no loop to reason about.
   *   The `primary !== here` check covers the degenerate case where a platform
   *   host is also registered as a school address.
   *
   *   NEVER A DESTINATION FROM THE REQUEST. The host comes from `schoolDomains`,
   *   which is ResultPeak-owned and validated on write; `?next=` only chooses a
   *   PATH, out of the exact set above.
   *
   * A school with no lessons address of its own gets "" from primaryAddress()
   * and the unchanged path below, which is most schools and is not a gap.
   */
  const here = normaliseHostname(
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? ""
  );

  if (isPlatformHost(here, platformConfig())) {
    const jar = await cookies();
    const signedIn = SESSION_COOKIES.some((name) => Boolean(jar.get(name)?.value));

    if (!signedIn) {
      const primary = normaliseHostname(await primaryAddress(school.id));

      if (primary && primary !== here) {
        const onward = new URL(`/s/${encodeURIComponent(school.slug)}`, `https://${primary}`);
        if (target !== "/") onward.searchParams.set("next", target);
        return NextResponse.redirect(onward);
      }
    }
  }

  const res = NextResponse.redirect(new URL(target, req.url));
  res.cookies.set(SCHOOL_COOKIE, school.id, schoolCookieOptions());
  res.cookies.set(PINNED_COOKIE, school.id, schoolCookieOptions());
  return res;
}
