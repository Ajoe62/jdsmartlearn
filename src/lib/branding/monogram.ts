/**
 * A school's two-letter monogram, derived from its name.
 *
 * NO "server-only" and no imports, deliberately - same treatment as
 * src/lib/auth/claims.ts. It runs on the server, in a client component after an
 * offline sync, and in the test file, and it is worth testing against the real
 * function rather than a copy of it.
 *
 * THIS IS THE MOST LOAD-BEARING FUNCTION IN THE BRANDING WORK, and it looks like
 * the least. Almost no school will have uploaded a crest on the day this ships.
 * If the header is blank until an admin acts, the feature is broken for every
 * school at once, and the first thing anyone sees is a gap where their identity
 * was promised. With this, every school looks like itself from the first
 * sign-in and a crest uploaded later is an improvement rather than a rescue.
 *
 * See docs/SCHOOL-BRANDING.md section 5.
 */

/**
 * Grammar. NEVER an initial, at any stage.
 *
 * "THE GOOD SHEPHERD SCHOOL" has to come out GS, and "The Cedar School" has to
 * come out CS - not TG and not TC. A leading "The" is the single most common way
 * a derived monogram goes wrong, because it is both first and meaningless.
 */
const NEVER = new Set(["the", "and", "of", "for", "ltd", "limited"]);

/**
 * Words that describe what a school IS rather than which school it is.
 *
 * These are initials OF LAST RESORT, and that is the difference from NEVER
 * above. A name with two distinctive words does not need them - "Mount Cedar
 * Academy" is MC. A name with only one does: dropping them would leave
 * "Capstone Academy" as a lonely C, when the school itself writes CA.
 *
 * Every entry appears in Nigerian school names often enough to swallow the
 * actual name if it were counted first.
 */
const TYPE = new Set([
  "school",
  "schools",
  "academy",
  "academies",
  "college",
  "colleges",
  "institute",
  "institution",
  "international",
  "nursery",
  "primary",
  "secondary",
  "comprehensive",
  "grammar",
  "group",
  "centre",
  "center",
]);

/** Letters and digits only - "St." and "Mary's" must not lose their initial. */
function words(name: string): string[] {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Two letters, uppercased.
 *
 *   CAPSTONE ACADEMY          -> CA
 *   THE GOOD SHEPHERD SCHOOL  -> GS
 *   St. Mary's International  -> SM
 *
 * The fallback order is the whole design. Grammar goes first and never comes
 * back. Then prefer the initials of the first two DISTINCTIVE words; when a name
 * has fewer than two of those, let the type words back in - which is why
 * CAPSTONE ACADEMY keeps its A rather than degrading to a single C. A name that
 * is one distinctive word and nothing else yields one letter, and that is
 * correct: "CA" invented from "Capstone" alone would be a monogram the school
 * does not use.
 */
export function monogram(name: string): string {
  const all = words(name).filter((w) => !NEVER.has(w.toLowerCase()));

  // A school with no name is a ResultPeak data problem, and getSchoolDirectory()
  // already filters those out. Return something renderable rather than throwing
  // inside a header.
  if (all.length === 0) return "?";

  const distinctive = all.filter((w) => !TYPE.has(w.toLowerCase()));
  const source = distinctive.length >= 2 ? distinctive : all;

  return source
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join("");
}

/**
 * A short name for a 360px header, when an admin has not set one.
 *
 * Drops a trailing generic word only - "CAPSTONE ACADEMY" reads fine as
 * "Capstone" in a header 34 pixels tall. Never touches the middle of a name,
 * because "Good Shepherd School" shortened to "Good School" is a different
 * school.
 *
 * Returns the full name unchanged when trimming would leave nothing, and the
 * caller still truncates: this reduces the common case, it does not guarantee a
 * width.
 */
export function shortenSchoolName(name: string): string {
  // Split on whitespace, NOT with words(): that strips punctuation, and
  // "St. Mary's Academy" must not come back as "St Mary s".
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return name;

  const bare = (token: string) => token.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

  // Only TYPE words are trimmed. NEVER words are grammar, and "The Cedar" reads
  // correctly while "Cedar" alone would be renaming the school.
  const trimmed = [...tokens];
  while (trimmed.length > 1 && TYPE.has(bare(trimmed[trimmed.length - 1]))) {
    trimmed.pop();
  }

  // Trimming must not leave grammar standing alone: "The Academy" -> "The" is
  // worse than the full name, and a header truncates anyway.
  if (trimmed.every((t) => NEVER.has(bare(t)))) return name;

  return trimmed.length === tokens.length ? name : trimmed.join(" ");
}
