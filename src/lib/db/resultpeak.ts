import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { RP, QUERY_LIMIT } from "./collections";
import type { ResultPeakClass, ResultPeakSchool, ResultPeakStudent } from "@/types";

/**
 * READ-ONLY accessors for ResultPeak data.
 * Every query filters by schoolId and is limited - the Spark quota is shared
 * with a live paying school. See CLAUDE.md.
 */

export async function getSchool(schoolId: string): Promise<ResultPeakSchool | null> {
  const snap = await adminDb.doc(`${RP.schools}/${schoolId}`).get();
  return snap.exists ? (snap.data() as ResultPeakSchool) : null;
}

/** Canonical subject list - subject.id is the join key used by topics and exams. */
export async function getSubjects(schoolId: string) {
  return (await getSchool(schoolId))?.subjects ?? [];
}

export async function getClassesByIds(ids: string[]) {
  if (!ids.length) return [];
  const refs = ids.slice(0, 30).map((id) => adminDb.doc(`${RP.classes}/${id}`));
  const snaps = await adminDb.getAll(...refs);
  return snaps
    .filter((s) => s.exists)
    .map((s) => ({ id: s.id, ...(s.data() as ResultPeakClass) }));
}

/** All active classes in a school - for admins, who aren't limited to assignedClasses. */
export async function listClassesForSchool(schoolId: string) {
  const snap = await adminDb
    .collection(RP.classes)
    .where("schoolId", "==", schoolId)
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((s) => ({ id: s.id, ...(s.data() as ResultPeakClass) }))
    .filter((c) => c.isActive !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** uid -> display name for the school's tutors (admin lesson list attribution). */
export async function getTutorNames(schoolId: string): Promise<Map<string, string>> {
  const snap = await adminDb.collection(RP.tutors(schoolId)).limit(QUERY_LIMIT).get();
  const names = new Map<string, string>();
  for (const d of snap.docs) {
    const name = (d.data() as { name?: string }).name;
    if (name) names.set(d.id, name);
  }
  return names;
}

export async function getStudentsInClass(schoolId: string, classId: string) {
  const snap = await adminDb
    .collection(RP.students)
    .where("schoolId", "==", schoolId)
    .where("classId", "==", classId)
    .limit(QUERY_LIMIT)
    .get();

  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ResultPeakStudent) }));
}
