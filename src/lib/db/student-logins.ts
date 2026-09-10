import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP, QUERY_LIMIT } from "./collections";
import { loginDocId, normalizeUsername } from "./usernames";
import type { StudentLogin } from "@/types";

/**
 * Memorable sign-in names for students - RESOLVED HERE, ISSUED BY RESULTPEAK.
 *
 * A student used to type a 20-character Firestore document id. Now they type
 * `jss3-04`. A username is one half of a credential, and the credential
 * (`studentAccess`) is ResultPeak's, so ResultPeak owns the username too: it
 * writes `studentAccess/{studentId}.username` and its uniqueness reservation
 * `studentUsernames/{schoolId}_{username}` in the same batch that creates the
 * student. THIS REPO HAS NO CODE PATH THAT CREATES A USERNAME, and that absence
 * is the fix rather than an omission.
 *
 * It used to mint its own into `studentLogins`, starting at 1 and knowing
 * nothing about `studentAccess`, which handed a child TWO usernames: one on the
 * school office's printed sheet, one on the card their tutor printed here. A
 * Primary 3 pupil cannot be expected to know which product wants which.
 *
 * Usernames are derived from the CLASS, never from the child's name, so nothing
 * read here is personal data (see CLAUDE.md, "Minors' data").
 *
 * Both ResultPeak collections are Admin-SDK only (`allow read, write: if false`
 * for clients) in their canonical rules file, which is how this repo already
 * reads `studentAccess`. No rules change, no index, no migration.
 */

/** username -> studentId, scoped to one school. */
export async function resolveUsername(
  schoolId: string,
  username: string
): Promise<string | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;

  /**
   * 1. ResultPeak's reservation. One document get, because its id has the same
   *    `${schoolId}_${username}` shape this repo's own alias used - a get for a
   *    get, no query and no composite index.
   *
   * The school is re-checked on every branch below. The doc id already encodes
   * it, but a username from another school must be rejected even when the code
   * typed alongside it is valid, and that assertion belongs here as well as in
   * the caller.
   */
  const reserved = await adminDb
    .doc(`${RP.studentUsernames}/${loginDocId(schoolId, normalized)}`)
    .get();
  if (reserved.exists) {
    const data = reserved.data() as { schoolId?: string; studentId?: string };
    if (data.schoolId === schoolId && data.studentId) return data.studentId;
  }

  /**
   * 2. The credential itself, for a username issued before the reservation
   *    collection existed. Two equality filters, so Firestore serves it from
   *    single-field indexes - still no composite index.
   *
   * Mirrors ResultPeak's own resolver (`api/_lib/studentAuth.js`) rather than
   * inventing a second rule: one username must mean one child in both products.
   */
  const bySchool = await adminDb
    .collection(RP.studentAccess)
    .where("schoolId", "==", schoolId)
    .where("username", "==", normalized)
    .limit(1)
    .get();
  if (!bySchool.empty) return bySchool.docs[0]!.id;

  /**
   * 3. RETIRED ALIAS, KEPT FOR ONE RELEASE. Delete this branch in v0.2.0, with
   *    the rest of `studentLogins` - see `docs/studentlogins-retirement.md`.
   *
   * It exists so that a child holding a JD-minted username from before the
   * cutover is not locked out the hour this deploys. Nothing writes to the
   * collection any more, so it cannot grow and this branch cannot gain a new
   * reader.
   */
  const legacy = await adminDb
    .doc(`${JD.studentLogins}/${loginDocId(schoolId, normalized)}`)
    .get();
  if (!legacy.exists) return null;

  const login = legacy.data() as StudentLogin;
  return login.schoolId === schoolId ? login.studentId : null;
}

/** What a tutor hands a child: ResultPeak's username and ResultPeak's code. */
export interface StudentSignIn {
  /** Null on a credential issued before ResultPeak added usernames. */
  username: string | null;
  code: string;
}

/**
 * studentId -> { username, code }, for the teacher's sign-in card list.
 *
 * ONE `getAll` OVER `studentAccess`, because both values are fields on that one
 * ResultPeak document. That is strictly fewer reads than the pair of calls this
 * replaced (a `getAll` plus a chunked `in` query per 30 students), which matters
 * on a quota shared with a live school's exam day.
 *
 * More importantly it makes it structurally impossible for this page to print a
 * username that differs from the school office's printed sheet: they are now
 * the same field of the same document.
 *
 * `studentAccess` is ResultPeak-owned and only READ here. These are live
 * credentials: only ever return them to an authorized tutor for their own
 * class, and never to a student route.
 */
export async function signInsForStudents(
  schoolId: string,
  studentIds: string[]
): Promise<Map<string, StudentSignIn>> {
  const ids = studentIds.slice(0, QUERY_LIMIT);
  const found = new Map<string, StudentSignIn>();
  if (!ids.length) return found;

  const refs = ids.map((id) => adminDb.doc(`${RP.studentAccess}/${id}`));
  const snaps = await adminDb.getAll(...refs);

  for (const snap of snaps) {
    const access = snap.data() as
      | { code?: string; username?: string; schoolId?: string }
      | undefined;
    if (!access) continue;

    /**
     * Refuse a record that names a DIFFERENT school. Absent is allowed, not
     * ignored: records predating the field carry no `schoolId`, and dropping
     * them would take a live pupil off their own class's sheet. The caller has
     * already scoped the student ids to one class of one school.
     */
    if (access.schoolId && access.schoolId !== schoolId) continue;

    // No code is no sign-in, whatever the username says. The caller lists these
    // students separately as "can't sign in yet".
    if (typeof access.code !== "string" || !access.code) continue;

    found.set(snap.id, {
      username: typeof access.username === "string" && access.username ? access.username : null,
      code: access.code,
    });
  }

  return found;
}
