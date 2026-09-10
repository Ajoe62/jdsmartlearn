/**
 * Pure username helpers - no Firestore, no "server-only".
 *
 * READING ONLY. There is nothing here that MINTS a username, and that is
 * deliberate: ResultPeak issues the username with the access code, in the same
 * batch that creates the student. `classSlug()` and `usernameFor()` used to live
 * here and are gone with the code that called them - a helper that can build
 * `jss3-04` is the first half of a second registry.
 *
 * What remains is what turns something a child typed on a phone keyboard into a
 * value that can be looked up: see `resolveUsername()` in `db/student-logins.ts`,
 * which is the only caller.
 */

/** Usernames are typed on a phone keyboard: lowercase, digits, hyphen only. */
const USERNAME_RE = /^[a-z0-9-]{2,40}$/;

/**
 * The school lives in the doc id, so sign-in is one get and no query.
 *
 * The same shape on both collections this reads - ResultPeak's
 * `studentUsernames` reservation and the retired `studentLogins` alias - which
 * is what made the cutover a get for a get.
 */
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
