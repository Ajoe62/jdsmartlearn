import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { lookupSchoolDomain } from "@/lib/db/school-domains";
import { getBrandingSchoolId, getPinnedSchoolId } from "@/lib/auth/student";
import {
  platformConfig,
  resolveHostMode,
  shouldLookUpHost,
  type HostVerdict,
} from "./hostname";

/**
 * Which school this REQUEST arrived for, from the hostname.
 *
 * ============================================================================
 * A ROOT LAYOUT / SERVER HELPER, NOT MIDDLEWARE. THREE REASONS, ALL BINDING.
 * ============================================================================
 *
 * 1. The lookup needs the Admin SDK, and `firebase-admin` needs the Node
 *    runtime. Next middleware is Edge by default; Node middleware is still
 *    experimental in Next 15. Resolving here needs no experimental flag and no
 *    second Firestore client written against the REST API.
 *
 * 2. Middleware runs on EVERY request, including every static asset and every
 *    prefetch. A Firestore read there, on a Spark plan shared with a live
 *    school's exam day, is the daily quota. Here the read happens once per
 *    render, is cached for 15 minutes per hostname, and is skipped entirely for
 *    platform hosts (`shouldLookUpHost`).
 *
 * 3. `unstable_cache` and React `cache()` both work here and neither works in
 *    middleware, so the per-request and cross-request caching that makes point 2
 *    true is only available on this side.
 *
 * The cost of not using middleware is that a Server Component cannot SET a
 * cookie, so a stale school cookie is not physically rewritten during a plain
 * page render. That costs nothing, because nothing reads the cookie directly:
 * every caller goes through `brandingSchoolId()` below, where the hostname wins
 * before the cookie is even read. The cookie is reconciled in the route
 * handlers that already write cookies - see /api/student/session/refresh.
 *
 * React cache(): a layout, its generateMetadata and any page beneath it are
 * separate calls in one request, and without this each would resolve the host
 * again.
 */
export const resolveHost = cache(async (): Promise<HostVerdict> => {
  const jar = await headers();
  // x-forwarded-host first: a proxy rewrites `host` to its own upstream, and on
  // Vercel the forwarded value is the one the visitor actually typed.
  const raw = jar.get("x-forwarded-host") ?? jar.get("host") ?? "";

  const config = platformConfig();

  // A platform host is never looked up. That is the quota guard, and it is also
  // why localhost and every *.vercel.app preview behave exactly as they did
  // before this feature existed rather than reporting themselves unmapped.
  const mapping = shouldLookUpHost(raw, config) ? await lookupSchoolDomain(raw) : null;

  return resolveHostMode(raw, mapping, config);
});

/**
 * The school to DECORATE a pre-authentication screen with.
 *
 * ============================================================================
 * THE HOSTNAME BEATS THE COOKIE. ALWAYS. THIS IS THE COLLISION RULE.
 * ============================================================================
 *
 * /s/{slug} remembers a school on a device for a YEAR. So a phone that once
 * opened one school's link would otherwise carry that school's identity onto
 * every other school's address it ever visits - and the visitor typed the
 * address, while the cookie is a year-old side effect they have forgotten. A
 * stale cookie must never override the address somebody actually typed.
 *
 * Neither input is trusted for anything but decoration. The cookie is
 * attacker-supplied (any visitor can set it by opening /s/anything) and so is
 * the hostname (anybody may point a DNS record here). That is precisely why
 * this function is only ever called for a school that has NO SESSION: a
 * signed-in surface takes `schoolId` from the session, and showing a teacher
 * another school's crest above their own class's data is the failure that rule
 * exists to prevent (docs/SCHOOL-BRANDING.md 6c).
 *
 * Returns null on an unmapped hostname rather than falling through to the
 * cookie. An address nobody has set up is not an invitation to guess: the
 * not-set-up page is the answer, and it names no school.
 */
export async function brandingSchoolId(): Promise<string | null> {
  const host = await resolveHost();

  if (host.mode === "school") return host.schoolId;
  if (host.mode === "unmapped") return null;

  // "platform": the shared domain, localhost, a preview. Exactly today's
  // behaviour - the pin from /s/{slug}, then whatever the phone last used.
  return getBrandingSchoolId();
}

/**
 * The school this device BELONGS to, if any - the answer that suppresses the
 * picker and the "Change school" link.
 *
 * A SCHOOL'S OWN HOSTNAME PINS AS FIRMLY AS ITS OWN LINK. /s/{slug} pins a
 * device because the school itself sent the visitor; arriving at
 * `capstone.{zone}` is the same statement in a stronger form, since the school
 * had to be given that address and a DNS record had to point here. Offering a
 * school picker on a school's own front door is the brand failure the pin rule
 * exists to prevent (CLAUDE.md, "a pinned device is not offered another
 * school").
 *
 * `?school=change` still works, exactly as it does for a cookie pin. Stop
 * advertising the escape hatch, never remove it, or a transferring child is
 * stranded - and on a hostname pin there is no cookie for them to clear.
 */
export async function pinnedSchoolId(): Promise<string | null> {
  const host = await resolveHost();

  if (host.mode === "school") return host.schoolId;
  if (host.mode === "unmapped") return null;

  return getPinnedSchoolId();
}
