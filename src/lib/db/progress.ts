import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import type { StudentProgress } from "@/types/student-dashboard";

/**
 * One flat document per student per subject, at a deterministic id.
 *
 * No subcollections, so the cost of reading a student's whole progress is one
 * equality-filtered query with a known ceiling: a student has at most a dozen
 * subjects. That predictability is the point on a quota shared with a live
 * paying school.
 */

export function progressId(schoolId: string, studentId: string, subjectId: string): string {
  return `${schoolId}_${studentId}_${subjectId}`;
}

export async function getProgress(id: string): Promise<StudentProgress | null> {
  const snap = await adminDb.doc(`${JD.studentProgress}/${id}`).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as StudentProgress) : null;
}

/** Two equality filters, no orderBy. Needs NO composite index. */
export async function listProgressForStudent(schoolId: string, studentId: string) {
  const snap = await adminDb
    .collection(JD.studentProgress)
    .where("schoolId", "==", schoolId)
    .where("studentId", "==", studentId)
    .limit(20)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as StudentProgress)
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

/** Every student's progress in one subject, for a tutor view. */
export async function listProgressForSubject(schoolId: string, subjectId: string) {
  const snap = await adminDb
    .collection(JD.studentProgress)
    .where("schoolId", "==", schoolId)
    .where("subjectId", "==", subjectId)
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as StudentProgress);
}

/**
 * Merge two topic lists, newest last, capped.
 *
 * Merge rather than replace: one assignment says what that assignment showed,
 * not everything a child knows. The cap keeps a year of marking from growing an
 * unbounded array inside a document that is read on every progress page.
 */
const MAX_TOPICS = 12;

export function mergeTopics(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  // Reversed so the most recent evidence survives the cap.
  for (const topic of [...incoming, ...existing]) {
    const key = topic.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(topic.trim());
    if (merged.length === MAX_TOPICS) break;
  }
  return merged;
}

/**
 * A topic the student has now shown they know stops being a topic to revise.
 * Without this, an early weakness they later fixed follows them all term.
 */
export function removeMastered(toRevise: string[], mastered: string[]): string[] {
  const done = new Set(mastered.map((t) => t.trim().toLowerCase()));
  return toRevise.filter((t) => !done.has(t.trim().toLowerCase()));
}

/**
 * Create or update a progress document.
 *
 * `set(..., { merge: true })` at a deterministic id: no read first, no
 * transaction, one write. Counters are passed as absolute values by the caller,
 * which has just queried the submissions they are derived from, rather than
 * incremented blindly, so a replayed call cannot inflate them.
 */
export async function upsertProgress(
  schoolId: string,
  studentId: string,
  subjectId: string,
  patch: Partial<Omit<StudentProgress, "id" | "schoolId" | "studentId" | "subjectId">>
): Promise<void> {
  assertWritable(JD.studentProgress);
  await adminDb
    .doc(`${JD.studentProgress}/${progressId(schoolId, studentId, subjectId)}`)
    .set(
      { schoolId, studentId, subjectId, ...patch, lastUpdated: Date.now() },
      { merge: true }
    );
}
