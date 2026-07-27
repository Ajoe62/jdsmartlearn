import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import { classSlug, loginDocId, normalizeUsername, usernameFor } from "./usernames";
import type { StudentLogin } from "@/types";

/**
 * Memorable sign-in names for students.
 *
 * A student used to type a 20-character Firestore document id. Now they type
 * `jss3-04`. This is a credential ALIAS, not a roster: it maps a username to a
 * studentId and nothing else. ResultPeak still owns the student record and the
 * access code, so deactivating a student in ResultPeak still locks them out -
 * `verifyStudentCode` is unchanged and runs after this resolves.
 *
 * Usernames are derived from the CLASS, never from the child's name, so this
 * collection stores no personal data (see CLAUDE.md, "Minors' data").
 *
 * The doc id carries the school (`${schoolId}_${username}`), which makes
 * sign-in a single document get - no query, no composite index, one read.
 */

/** Firestore `in` queries take at most 30 values. */
const IN_CHUNK = 30;

/** username -> studentId, scoped to one school. One document read. */
export async function resolveUsername(
  schoolId: string,
  username: string
): Promise<string | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;

  const snap = await adminDb.doc(`${JD.studentLogins}/${loginDocId(schoolId, normalized)}`).get();
  if (!snap.exists) return null;

  const login = snap.data() as StudentLogin;
  // Belt and braces: the doc id already encodes the school.
  return login.schoolId === schoolId ? login.studentId : null;
}

/**
 * studentId -> username, for the teacher's sign-in card list.
 * Chunked `in` queries: one query for a class of 30, two for 60.
 */
export async function usernamesForStudents(
  schoolId: string,
  studentIds: string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const ids = studentIds.slice(0, QUERY_LIMIT);

  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const snap = await adminDb
      .collection(JD.studentLogins)
      .where("schoolId", "==", schoolId)
      .where("studentId", "in", chunk)
      .limit(IN_CHUNK)
      .get();

    for (const doc of snap.docs) {
      const login = doc.data() as StudentLogin;
      found.set(login.studentId, login.username);
    }
  }

  return found;
}

export interface AssignedLogin {
  studentId: string;
  username: string;
}

/**
 * Give every listed student a username, in the order supplied.
 *
 * Only ever called with students who already have an access code - a username
 * without a code is a dead end, and skipping the rest also filters out the
 * duplicate roster-only records that exist in ResultPeak.
 *
 * Uses `create()`, so an existing username is never overwritten and a second
 * run is a no-op. On collision the number increments, which is also how a
 * genuinely new student slots in behind the current class list.
 */
export async function assignClassLogins(
  schoolId: string,
  className: string,
  studentIds: string[]
): Promise<AssignedLogin[]> {
  assertWritable(JD.studentLogins);

  const existing = await usernamesForStudents(schoolId, studentIds);
  const missing = studentIds.filter((id) => !existing.has(id));
  if (!missing.length) return [];

  const prefix = classSlug(className);
  const assigned: AssignedLogin[] = [];
  let next = 1;

  for (const studentId of missing) {
    let placed = false;

    // Walk forward past taken numbers. Bounded by the class size plus whatever
    // was already assigned, so it cannot run away.
    while (!placed && next <= QUERY_LIMIT * 2) {
      const username = usernameFor(prefix, next);
      next += 1;
      try {
        const login: StudentLogin = {
          schoolId,
          studentId,
          username,
          createdAt: Date.now(),
        };
        await adminDb.doc(`${JD.studentLogins}/${loginDocId(schoolId, username)}`).create(login);
        assigned.push({ studentId, username });
        placed = true;
      } catch {
        // Taken by another student (or another tutor hitting the button at the
        // same moment). Try the next number.
      }
    }

    if (!placed) {
      throw new Error(`Could not find a free username for ${prefix} in school ${schoolId}`);
    }
  }

  return assigned;
}

/**
 * studentId -> access code, for the teacher's sign-in card list.
 *
 * `studentAccess` is ResultPeak-owned and only READ here. These are live
 * credentials: only ever return them to an authorized tutor for their own
 * class, and never to a student route.
 */
export async function accessCodesFor(studentIds: string[]): Promise<Map<string, string>> {
  const ids = studentIds.slice(0, QUERY_LIMIT);
  const codes = new Map<string, string>();
  if (!ids.length) return codes;

  const refs = ids.map((id) => adminDb.doc(`${RP.studentAccess}/${id}`));
  const snaps = await adminDb.getAll(...refs);
  for (const snap of snaps) {
    const code = (snap.data() as { code?: string } | undefined)?.code;
    if (typeof code === "string" && code) codes.set(snap.id, code);
  }
  return codes;
}
