/**
 * Pure username helpers - no Firestore, no "server-only".
 *
 * Split out so the assign-logins script can share the exact naming rules with
 * the server without importing a server-only module (see scripts/, and the
 * same reason list-students.ts builds its own Admin SDK app).
 */

/** Usernames are typed on a phone keyboard: lowercase, digits, hyphen only. */
const USERNAME_RE = /^[a-z0-9-]{2,40}$/;

/** The school lives in the doc id, so sign-in is one get and no query. */
export function loginDocId(schoolId: string, username: string): string {
  return `${schoolId}_${username}`;
}

/**
 * What a student typed, reduced to a comparable username.
 * Null when the input can't be a username - the caller may still try it as a
 * legacy student document id.
 */
export function normalizeUsername(input: string): string | null {
  const cleaned = input.trim().toLowerCase().replace(/\s+/g, "");
  return USERNAME_RE.test(cleaned) ? cleaned : null;
}

/**
 * `JSS 3` -> `jss3`, `Primary 4 (Gold)` -> `primary4-gold`.
 * Class names come from ResultPeak and are inconsistently spaced.
 */
export function classSlug(className: string): string {
  const slug = className
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Join a level word to its number: "jss-3" -> "jss3".
    .replace(/([a-z])-(\d)/g, "$1$2")
    .replace(/^-+|-+$/g, "");
  return slug || "class";
}

/** `jss3` + 4 -> `jss3-04`. Two digits keeps a class list sorting correctly. */
export function usernameFor(prefix: string, position: number): string {
  return `${prefix}-${String(position).padStart(2, "0")}`;
}
