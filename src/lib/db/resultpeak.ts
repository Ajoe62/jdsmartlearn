import "server-only";
import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { RP, QUERY_LIMIT } from "./collections";
import { teachableMap } from "@/lib/auth/subject-access";
import type { SubjectAllocation } from "@/lib/auth/subject-access";
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

/**
 * What a picker may offer: subjectId -> classIds, for the tutor's own allocation.
 *
 * `{}` means NO RESTRICTION - an unallocated tutor, or an admin - and both forms
 * read it that way. Keeping that convention in one place is what stops each form
 * inventing its own idea of the legacy state.
 *
 * Costs no extra Firestore read beyond the subject list the pages already fetch,
 * and nothing here is cached on the device: the allocation is re-read from the
 * session on every request, exactly as assignedClasses is, so a revocation in
 * ResultPeak applies immediately (CLAUDE.md, Tutor offline).
 */
export async function getTeachableMap(
  schoolId: string,
  allocation: SubjectAllocation,
  heldClassIds: string[]
): Promise<Record<string, string[]>> {
  const subjects = await getSubjects(schoolId);
  return teachableMap(
    allocation,
    subjects.map((s) => s.id),
    heldClassIds
  );
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

export interface SchoolListing {
  id: string;
  name: string;
  /** URL form of the name, for the /s/{slug} link a school puts on the board. */
  slug: string;
}

export function schoolSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Active schools, for the student sign-in picker.
 *
 * A username like `jss3-04` is only unique inside a school, so the school has
 * to be established before sign-in. This is ONE query per SCHOOL_DIRECTORY_TTL
 * shared by every student on every device - school names change about never.
 * Only the id and name leave this function; no student data is involved.
 */
export const getSchoolDirectory = unstable_cache(
  async (): Promise<SchoolListing[]> => {
    const snap = await adminDb.collection(RP.schools).limit(QUERY_LIMIT).get();
    const all = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as ResultPeakSchool) }))
      .filter((s) => s.isActive !== false && !!s.name);

    // Two schools genuinely share a name in this project. Left alone, a child
    // picks one of two identical rows and can never sign in. Nothing else on
    // the school doc tells them apart, so fall back to a short id.
    const counts = new Map<string, number>();
    for (const s of all) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);

    return all
      .map((s) => ({
        id: s.id,
        name: (counts.get(s.name) ?? 0) > 1 ? `${s.name} (${s.id.slice(0, 4)})` : s.name,
        slug: schoolSlug(s.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  ["school-directory"],
  { revalidate: 21600 } // 6 hours
);

/** Resolve a /s/{slug} link. Null when unknown or ambiguous - fall back to the picker. */
export async function findSchoolBySlug(slug: string): Promise<SchoolListing | null> {
  const matches = (await getSchoolDirectory()).filter((s) => s.slug === slug);
  return matches.length === 1 ? matches[0] : null;
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
