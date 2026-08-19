/**
 * Links from JDSmartLearn back into ResultPeak.
 *
 * The two products share a Firebase project but not a repository or a domain,
 * so neither can import the other's routes and neither can be sure the other is
 * deployed. One environment variable is the whole contract.
 *
 * THE RULE EVERY CALL SITE FOLLOWS: an unset variable returns "" and the caller
 * renders NOTHING. Not a disabled button, not a link to a placeholder. A dead
 * link on a screen a school is looking at is worse than an absent one, because
 * the absent one is a feature nobody knew to miss and the dead one is a product
 * that looks broken.
 *
 * This is the mirror of ResultPeak's `src/lib/partnerLinks.js`, which reads
 * `VITE_JDSMARTLEARN_URL`. The two sides are independent: each renders its link
 * only when its own variable is set, neither reads a field the other writes, and
 * either may ship without the other.
 *
 * NEXT_PUBLIC_ is correct here. The value is a public URL that has to reach the
 * browser, and it is not a secret in any sense.
 */

/** Trailing slashes removed, so joining a path can never produce "//". */
function normalizeBase(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/** The configured ResultPeak origin, or "". */
export function resultPeakBase(): string {
  return normalizeBase(process.env.NEXT_PUBLIC_RESULTPEAK_URL);
}

/** A ResultPeak URL for a path, or "" when the product is not configured. */
export function resultPeakUrl(path = ""): string {
  const base = resultPeakBase();
  if (!base) return "";
  const suffix = path.trim();
  if (!suffix) return base;
  return `${base}${suffix.startsWith("/") ? "" : "/"}${suffix}`;
}

/**
 * Where a member of staff goes: ResultPeak's admin area.
 *
 * No school in the path on purpose. Staff sign in there with their own Firebase
 * account and their custom claims already carry `schoolId`, so naming a school
 * here would say something the destination already knows.
 */
export function resultPeakStaffUrl(): string {
  return resultPeakUrl("/admin");
}

/**
 * Where a child goes: their own school's ResultPeak portal.
 *
 * With a slug this is `/s/{slug}`, which ResultPeak serves as its portal chooser
 * with the school already picked. Without one, the plain front door, because
 * guessing a school for a child who arrived without naming one would land them
 * at the wrong school's exams.
 */
export function resultPeakSchoolUrl(slug?: string | null): string {
  const clean = (slug ?? "").trim().toLowerCase();
  return clean ? resultPeakUrl(`/s/${encodeURIComponent(clean)}`) : resultPeakUrl("");
}
