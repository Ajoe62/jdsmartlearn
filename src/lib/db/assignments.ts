import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, LIST_LIMIT, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import type { Assignment } from "@/types/student-dashboard";

/**
 * Assignments: the tutor-owned half of the assessment loop.
 *
 * Every query here is equality-only and limited, sorted in memory. That is what
 * keeps this repo free of composite indexes on a project shared with a live
 * paying school. See docs/firestore-indexes-to-append.md before adding a query.
 */

export async function createAssignment(
  data: Omit<Assignment, "id" | "createdAt" | "updatedAt">
): Promise<string> {
  assertWritable(JD.assignments);
  const now = Date.now();
  const ref = await adminDb
    .collection(JD.assignments)
    .add({ ...data, createdAt: now, updatedAt: now });
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
 * Active assignments a class can see. Three equality filters, no orderBy.
 *
 * Returns the FULL documents, marking guide included, so every caller on a
 * student path must project through toStudentAssignment() before responding.
 */
export async function listActiveAssignmentsForClass(schoolId: string, classId: string) {
  const snap = await adminDb
    .collection(JD.assignments)
    .where("schoolId", "==", schoolId)
    .where("classId", "==", classId)
    .where("isActive", "==", true)
    .limit(LIST_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Assignment)
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
export const SUBMISSION_GRACE_MS = 60 * 60 * 1000;

export function isSubmittable(a: Pick<Assignment, "isActive" | "dueDate">, now = Date.now()) {
  return a.isActive && now <= a.dueDate + SUBMISSION_GRACE_MS;
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
