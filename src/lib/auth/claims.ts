// Pure claim judgement. NO "server-only" here, and nothing imported beyond a
// type, deliberately: this is the check that decides whether an account may act
// at all, and it is worth testing against the real function rather than a copy
// of it. Same treatment as src/lib/assessment/ca.ts, and covered by the same
// module-boundary guard - it must never grow an import of firebase-admin, a
// secret, or anything under src/lib/db.
//
// It holds no secret and reads no environment. A claims object is data the
// caller already has; deciding it is not fit to act leaks nothing.

import type { Claims } from "@/types";

/** Why a verified token is still not allowed to act. `null` means allowed. */
export type ClaimRefusal = "no_school" | "inactive" | "must_change_password";

/**
 * The ONLY place a claim is judged fit to act on. Mirrors isActiveClaim() in
 * ResultPeak's canonical firestore.rules, plus the schoolId this product needs.
 *
 * Both callers - the sign-in exchange and every request that resolves a session
 * - go through this one function on purpose. The 2026-08-12 rules incident (see
 * docs/firestore-rules-to-append.md) happened because the same test was written
 * out by hand in five places and one of them was weaker than the rest.
 *
 * Two details are load-bearing and neither is the obvious way to write it:
 *
 *   `active !== true`, not `active === false`. A token carrying no `active`
 *   claim at all is denied, matching the rules. Written the permissive way it
 *   admits exactly the tokens the rules reject, which is the worst direction
 *   for the two to disagree in.
 *
 *   `mustChangePassword` is checked here, and it is the reason this returns a
 *   reason rather than a boolean. An account holding a temporary password a
 *   superadmin issued still has `active: true` and keeps its schoolId
 *   (ResultPeak's api/_lib/adminActions.js preserves the claims on reset), so
 *   nothing else about the token says it is not ready. ResultPeak denies it at
 *   its rules and at its own API; this product used to admit it, and admit it
 *   as an ADMIN, which skips assertClassAccess entirely.
 */
export function claimRefusal(claims: Partial<Claims>): ClaimRefusal | null {
  if (!claims.schoolId) return "no_school";
  if (claims.active !== true) return "inactive";
  if (claims.mustChangePassword === true) return "must_change_password";
  return null;
}
