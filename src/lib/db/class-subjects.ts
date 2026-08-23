import "server-only";
import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { RP, QUERY_LIMIT } from "./collections";
import { getSubjects } from "./resultpeak";
import type { ResultPeakTutor } from "@/types";

/**
 * WHICH SUBJECTS A CLASS OFFERS - DERIVED, AND A WORKAROUND.
 *
 * ResultPeak has no per-class subject list. `schools/{id}.subjects[]` is
 * school-wide, and `classes/{id}` carries `name`, `schoolId`, `isActive` and
 * sometimes `level` - no subjects at all. The only class-to-subject link
 * anywhere in the shared project is the tutor allocation
 * `schools/{id}/tutors/{uid}.subjectClasses`.
 *
 * So this derives the list, and the derivation is WRONG IN ONE VISIBLE WAY: a
 * subject the class genuinely offers, with no tutor allocated yet and no content
 * uploaded yet, does not appear. To a parent that looks like the school dropped
 * a subject. The real fix is `classes/{id}.subjectIds[]` owned by ResultPeak -
 * see docs/resultpeak-class-subjects-prompt.md. When it ships,
 * `getClassSubjects` reads it and this file is deleted.
 *
 * DO NOT PERSIST THIS. It was designed as a `jdClassSubjects` document per class
 * and dropped, because the expensive half is the allocation scan and a per-class
 * document does not make it cheaper - see the note in collections.ts.
 */

/**
 * How long the allocation scan is reused.
 *
 * Ten minutes. Longer than the lesson bundle's five, because an admin editing a
 * tutor's allocation in ResultPeak is a rare, deliberate act, while a lesson is
 * published mid-lesson. THIS IS A DISPLAY CACHE ONLY and never an authorization
 * one: `assertClassAccess` and `teachesSubjectInClass` read the tutor's own
 * session, which is re-read per request, so a revocation still applies instantly.
 */
const ALLOCATION_REVALIDATE_SECONDS = 600;

export const classSubjectsTag = (schoolId: string) => `class-subjects:${schoolId}`;

/**
 * classId -> the subjectIds some tutor is allocated to teach it.
 *
 * ONE SCAN PER SCHOOL, cached, and that is the entire reason this function
 * exists in this shape. Deriving per class would rescan `schools/{id}/tutors` -
 * up to QUERY_LIMIT documents - once for every class in the school. Twelve
 * classes would be twelve scans of the same collection for the same answer.
 *
 * An UNALLOCATED tutor contributes nothing here, which is the opposite of how
 * `isUnallocated()` treats them for authorization, and the difference is
 * deliberate. There, an empty allocation means "every subject", so a tutor
 * ResultPeak has not configured yet keeps working. Here, reading it that way
 * would say every class offers every subject in the school - a Primary 2 shelf
 * with Further Mathematics on it. Authorization fails open; a curriculum list
 * must not.
 */
const getSchoolAllocation = (schoolId: string) =>
  unstable_cache(
    async (): Promise<Record<string, string[]>> => {
      const snap = await adminDb.collection(RP.tutors(schoolId)).limit(QUERY_LIMIT).get();

      const byClass = new Map<string, Set<string>>();
      for (const doc of snap.docs) {
        const tutor = doc.data() as ResultPeakTutor;
        const map = tutor.subjectClasses ?? {};
        for (const [subjectId, classIds] of Object.entries(map)) {
          if (!Array.isArray(classIds)) continue;
          for (const classId of classIds) {
            const set = byClass.get(classId) ?? new Set<string>();
            set.add(subjectId);
            byClass.set(classId, set);
          }
        }
      }

      return Object.fromEntries([...byClass].map(([k, v]) => [k, [...v]]));
    },
    ["school-allocation", schoolId],
    { tags: [classSubjectsTag(schoolId)], revalidate: ALLOCATION_REVALIDATE_SECONDS }
  )();

export interface ClassSubject {
  id: string;
  name: string;
  /**
   * Why this subject is on the list. Drives the "some subjects may be missing"
   * notice: when every subject arrived via `content`, nobody has been allocated
   * and the list is certainly incomplete.
   */
  source: "allocation" | "content";
}

/**
 * The subjects a class offers, resolved and named.
 *
 * `observed` is the subject ids that actually have something for this class -
 * passed in by the caller, which already holds the lesson bundle and the
 * assignment list, so this costs no query of its own beyond the cached
 * allocation scan and the cached school document.
 *
 * Ordering is alphabetical by name. The admin's own order would be better and
 * is what `classes/{id}.subjectIds[]` will bring; there is no order to honour
 * until then, and inventing one from allocation iteration order would change
 * between reads.
 */
export async function getClassSubjects(
  schoolId: string,
  classId: string,
  observed: Iterable<string>
): Promise<ClassSubject[]> {
  const [subjects, allocation] = await Promise.all([
    getSubjects(schoolId),
    getSchoolAllocation(schoolId),
  ]);

  const nameById = new Map(subjects.map((s) => [s.id, s.name]));
  const allocated = new Set(allocation[classId] ?? []);

  const out = new Map<string, ClassSubject>();

  for (const id of allocated) {
    // A subject removed from the school document since the allocation was made.
    // Dropped rather than shown by id: a shelf row reading "further_maths" is
    // worse than no row.
    const name = nameById.get(id);
    if (name) out.set(id, { id, name, source: "allocation" });
  }

  for (const id of observed) {
    if (out.has(id)) continue;
    const name = nameById.get(id);
    if (name) out.set(id, { id, name, source: "content" });
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True when nobody in this school has been allocated to this class, so the
 * subject list can only be what happens to have content.
 *
 * The student shelf says so in plain words rather than silently showing a short
 * list. A child who cannot see Civic Education should be told the school has not
 * finished setting up, not left to assume it was dropped.
 */
export function isDerivedFromContentOnly(subjects: ClassSubject[]): boolean {
  return subjects.length > 0 && subjects.every((s) => s.source === "content");
}
