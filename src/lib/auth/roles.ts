import "server-only";
import type { Claims } from "@/types";

/**
 * Single source of truth for interpreting ResultPeak's role claims.
 *
 * ResultPeak owns the Auth directory and stamps `role` + `superadmin` onto each
 * user's custom claims. JDSmartLearn only READS them. Real values seen in
 * production: role="schooladmin" with superadmin=true for admins, role="tutor"
 * for teachers. Do NOT compare role strings inline anywhere else - if ResultPeak
 * adds another admin-like role, it should be a one-line change here.
 */
const ADMIN_ROLES: ReadonlySet<string> = new Set(["schooladmin", "admin"]);

/** True for any admin-level actor (school admin or superadmin). */
export function isAdmin(claims: Pick<Claims, "role" | "superadmin">): boolean {
  return claims.superadmin === true || ADMIN_ROLES.has(claims.role);
}
