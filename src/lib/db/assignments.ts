import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, QUERY_LIMIT } from "./collections";
import { reportIfCapped } from "@/lib/list-cap";
import { assertWritable } from "./write-guard";
import type { Assignment } from "@/types/student-dashboard";
import { isAssignmentSubmittable, isAssignmentVisibleToStudent, SUBMISSION_GRACE_MS } from "@/lib/assignments/availability";

/**
 * Assignments: the tutor-owned half of the assessment loop.
 *
 * Every query here is equality-only and limited, sorted in memory. That is what
 * keeps this repo free of composite indexes on a project shared with a live
 * paying school. See docs/firestore-indexes-to-append.md before adding a query.
 */

/**
 * A fresh assignment id, WITHOUT writing anything. Lets a question sheet be
 * stored under the assignment's own key before the document exists.
 */
export function newAssignmentId(): string {
  return adminDb.collection(JD.assignments).doc().id;
}

export async function createAssignment(
  data: Omit<Assignment, "id" | "createdAt" | "updatedAt">,
  id?: string
): Promise<string> {
  assertWritable(JD.assignments);
  const now = Date.now();
  const doc = { ...data, createdAt: now, updatedAt: now };
  if (id) {
    // create(), not set(): refuses rather than overwrites if an id ever repeated.
    await adminDb.collection(JD.assignments).doc(id).create(doc);
    return id;
  }
  const ref = await adminDb.collection(JD.assignments).add(doc);
  return ref.id;
}

export async function getAssignment(id: string): Promise<Assignment | null> {
  const snap = await adminDb.doc(`${JD.assignments}/${id}`).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Assignment) : null;
}

/** Two equality filters, no orderBy. Needs NO composite index. */
export async function listAssignmentsForTutor(schoolId: string, tutorId: string) {
  const snap = await adminDb
    .collection(JD.assignments)
    .where("schoolId", "==", schoolId)
    .where("tutorId", "==", tutorId)
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Assignment)
    .sort((a, b) => b.dueDate - a.dueDate);
}

/**
 * Assignments in ONE class, active or not, for the class -> subject view.
 * Equality filters only, no orderBy: needs NO composite index whichever are set.
 *
 * `markingGuide` is left out by `.select()` - this list never shows it, so it
 * has no reason to be read. `tutorId` narrows a teacher to their own work;
 * admins pass none and see the class's.
 */
export async function listAssignmentsInClass(filter: {
  schoolId: string;
  classId: string;
  tutorId?: string;
  subjectId?: string;
}): Promise<Assignment[]> {
  let q = adminDb
    .collection(JD.assignments)
    .where("schoolId", "==", filter.schoolId)
    .where("classId", "==", filter.classId);
  if (filter.tutorId) q = q.where("tutorId", "==", filter.tutorId);
  if (filter.subjectId) q = q.where("subjectId", "==", filter.subjectId);
  const snap = await q
    .select(
      "classId", "className", "subjectId", "subjectName", "tutorId", "title",
      "type", "dueDate", "maxMarks", "term", "session", "isActive", "updatedAt"
    )
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Assignment)
    .sort((a, b) => b.dueDate - a.dueDate);
}

/**
 * Active assignments a class can see, in ONE school year. Equality filters
 * only, no orderBy, so no composite index (verified against the live project
 * on 2026-11-26).
 *
 * WHY THE SCHOOL YEAR, AND WHY NOT THE TERM (2026-11-26). This used to read at
 * most 50 with no ordering and no year filter. Firestore then returns an
 * arbitrary 50, so once a class passed 50 (future scheduled work counts too),
 * work due tomorrow could silently drop off a child's screen.
 *
 *   - Filtering by `session` keeps earlier years from filling the list.
 *   - NOT by the current term: holiday work for next term is set, opened and
 *     done while the school is still in this term (Mt Cedar, December 2026).
 *     A term filter would hide every holiday assignment.
 *   - The limit is QUERY_LIMIT, not LIST_LIMIT: a whole year of one class.
 *     The phone still receives only what is visible now, filtered below.
 *
 * `session` is ResultPeak's current session, verbatim. Null (the school has not
 * set its term in School profile) reads without the year filter, as before,
 * rather than showing nothing. A full result is logged by reportIfCapped.
 *
 * Returns the FULL documents, marking guide included, so every caller on a
 * student path must project through toStudentAssignment() before responding.
 */
export async function listActiveAssignmentsForClass(
  schoolId: string,
  classId: string,
  session: string | null,
  now = Date.now(),
  includeUnavailable = false
) {
  let q = adminDb
    .collection(JD.assignments)
    .where("schoolId", "==", schoolId)
    .where("classId", "==", classId)
    .where("isActive", "==", true);
  if (session) q = q.where("session", "==", session);
  const snap = await q.limit(QUERY_LIMIT).get();
  reportIfCapped(snap.docs, "class assignments", QUERY_LIMIT, { schoolId, classId, session });
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Assignment)
    .filter((assignment) => includeUnavailable || isAssignmentVisibleToStudent(assignment, now))
    .sort((a, b) => a.dueDate - b.dueDate);
}

/**
 * The student-safe projection of an assignment.
 *
 * Re-exported from `assessment/projection.ts`, which carries no `server-only`
 * so the guarantee that `markingGuide` never reaches a student can be tested
 * against the real function. Callers keep importing it from here.
 */
export { toStudentAssignment } from "@/lib/assessment/projection";

/**
 * How long after the due date a submission is still accepted.
 *
 * A child on a shared phone with intermittent signal loses a whole assignment to
 * a clock, not to idleness. One hour is the grace the spec asks for; the
 * interface still shows the assignment as overdue so nobody thinks it is free.
 */
export { SUBMISSION_GRACE_MS };

export function isSubmittable(a: Pick<Assignment, "isActive" | "dueDate" | "opensAt" | "closesAt">, now = Date.now()) {
  return isAssignmentSubmittable(a, now);
}

/**
 * A feed item. One document for a whole class, not one per student: a class of
 * forty would otherwise cost forty writes for a single announcement, on a shared
 * free-tier quota that a live school's exam day also draws from.
 */
export async function writeNotification(entry: {
  schoolId: string;
  /** "class" targets a classId, "tutor" targets a tutor uid. */
  audience: "class" | "tutor";
  targetId: string;
  type: string;
  title: string;
  /** Short plain-text line shown under the title. */
  body: string;
  entityId: string;
}): Promise<void> {
  assertWritable(JD.notifications);
  await adminDb.collection(JD.notifications).add({ ...entry, createdAt: Date.now() });
}
