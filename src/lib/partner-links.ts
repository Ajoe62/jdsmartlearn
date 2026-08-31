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
 *
 * ============================================================================
 * A SCHOOL WITH ITS OWN DOMAIN OVERRIDES THE VARIABLE, AND NEITHER IS REQUIRED.
 * ============================================================================
 *
 * ResultPeak writes `resultsUrl` onto `schoolBranding/{id}` for a school that
 * runs its results service on a domain of its own. Every function here takes
 * that origin as an OPTIONAL last argument, reached through
 * `SchoolBrand.resultsUrl` and never read from the document directly.
 *
 * The precedence is: the school's own origin, then the variable, then "". Most
 * schools have no domain and that field is absent, which is the normal case and
 * not a gap — they keep landing on the shared deployment. Neither source is ever
 * required, and a school with its own domain still links correctly on a
 * deployment where the variable was never set.
 */

/** Trailing slashes removed, so joining a path can never produce "//". */
function normalizeBase(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * An https origin and nothing else: scheme, host, optional port. No path, no
 * query, no credentials.
 *
 * CHECKED HERE BECAUSE THE VALUE COMES FROM ANOTHER PRODUCT'S DOCUMENT AND ENDS
 * UP IN AN `href`. ResultPeak validates on write, but a value can predate a rule
 * or be typed into the Firebase console, and this is the last point before a
 * school's staff and children click it. Same reasoning as `isSafeCrestUrl`, and
 * the same failure mode it prevents: an attacker-controlled scheme in a link a
 * child is told to follow.
 *
 * A path is refused rather than trimmed. `https://host/portal` is a school
 * saying something the field is not for, and quietly keeping the origin would
 * send them somewhere they did not configure.
 */
const SAFE_PARTNER_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

export function isSafePartnerOrigin(value: unknown): boolean {
  return SAFE_PARTNER_ORIGIN.test(normalizeBase(String(value ?? "")));
}

/**
 * The school's own origin, or "" — including when it is present but not a safe
 * origin, in which case the caller falls back to the shared deployment rather
 * than losing the link. A refusal must never take a school's results link off
 * every screen at once.
 */
function schoolOrigin(origin: string | null | undefined): string {
  const own = normalizeBase(origin);
  return own && isSafePartnerOrigin(own) ? own : "";
}

/** The school's own ResultPeak origin, else the configured one, else "". */
export function resultPeakBase(origin?: string | null): string {
  return schoolOrigin(origin) || normalizeBase(process.env.NEXT_PUBLIC_RESULTPEAK_URL);
}

/** A ResultPeak URL for a path, or "" when the product is not configured. */
export function resultPeakUrl(path = "", origin?: string | null): string {
  const base = resultPeakBase(origin);
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
export function resultPeakStaffUrl(origin?: string | null): string {
  return resultPeakUrl("/admin", origin);
}

/**
 * Where a child goes: their own school's ResultPeak portal.
 *
 * ON THE SHARED DEPLOYMENT this is `/s/{slug}`, which ResultPeak serves as its
 * portal chooser with the school already picked. Without a slug, the plain front
 * door, because guessing a school for a child who arrived without naming one
 * would land them at the wrong school's exams.
 *
 * ON THE SCHOOL'S OWN DOMAIN THE SLUG IS DROPPED, and that is a correctness rule
 * rather than a tidiness one. The hostname already identifies the school;
 * appending a slug would be a second source of truth that can contradict the
 * first, and this repo's slug is DERIVED from the school's name (`schoolSlug`),
 * not stored. A school that renames itself, or whose own domain is set up for a
 * different slug, would get `https://their-domain/s/some-other-school` — a
 * confident link to the wrong school, built from two answers to one question.
 */
export function resultPeakSchoolUrl(slug?: string | null, origin?: string | null): string {
  const own = schoolOrigin(origin);
  if (own) return own;

  const clean = (slug ?? "").trim().toLowerCase();
  return clean ? resultPeakUrl(`/s/${encodeURIComponent(clean)}`) : resultPeakUrl("");
}

/**
 * Where a child goes to read their own term result sheet.
 *
 * `/start/student` rather than `/start`, because ResultPeak's chooser asks
 * enrolled student or entrance applicant, and a child arriving from here has a
 * login already — the question is one card too many.
 *
 * `?next=results` is a flag, not a destination. ResultPeak recognises only the
 * literal value "results"; it titles the page "See your results" and opens the
 * result sheet after sign-in instead of an exam picker nobody asked for. Nothing
 * here is a URL, so there is no open redirect to widen.
 *
 * A PATH, NOT A SLUG, so it is kept on the school's own domain too. The rule in
 * resultPeakSchoolUrl drops the SLUG, because a hostname and a slug are two
 * answers to "which school"; `/start/student` answers "which screen" and the
 * school's own deployment serves it exactly as the shared one does.
 *
 * No school in the path, for the reason in resultPeakSchoolUrl and in
 * src/app/(student)/student/page.tsx: the session carries schoolId, not the
 * slug, and resolving one would add a Firestore read to every dashboard load of
 * every student to save a single tap.
 */
export function resultPeakStudentResultsUrl(origin?: string | null): string {
  return resultPeakUrl("/start/student?next=results", origin);
}
