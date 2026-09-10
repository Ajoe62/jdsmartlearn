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

/**
 * DELIBERATELY NOT CACHED, and it must stay that way.
 *
 * The obvious optimisation - this document is read from a dozen places and
 * changes about never - is wrong, because of ONE field on it. Three callers read
 * `assessmentTypes` precisely because it can change under them: ResultPeak lets
 * an admin drop an assessment type after scores exist, so a mapping that was
 * valid last term can point at nothing today. `academic-records.ts` re-reads it
 * before deciding whether a child's CA mark is written or skipped, `skips.ts`
 * re-reads it to warn a tutor before a result sheet does, and the settings route
 * re-reads it to validate what an admin just picked. All three say so in their
 * own comments.
 *
 * A cache here would put a staleness window in front of a decision about a real
 * child's marks, to save a read. If you need one slow-changing field off this
 * document cheaply, cache THAT FIELD ALONE the way
 * getSubjectAllocationEnforced() below does - never the document.
 */
export async function getSchool(schoolId: string): Promise<ResultPeakSchool | null> {
  const snap = await adminDb.doc(`${RP.schools}/${schoolId}`).get();
  return snap.exists ? (snap.data() as ResultPeakSchool) : null;
}

/**
 * Whether this school enforces (classId, subjectId) tutor allocation.
 *
 * ABSENT MEANS OFF. Every school is here today, so this returns false
 * everywhere until a school opts in.
 *
 * CACHED, unlike getSchool() above, and the difference is the point: only the
 * boolean crosses the cache boundary, so nothing can later reach into a cached
 * school object for `assessmentTypes` and pick up a stale mapping. It reads the
 * document directly rather than calling getSchool() for the same reason - there
 * is no cached ResultPeakSchool anywhere for a future caller to find.
 *
 * Called once per tutor request from getTutorSession(), so it has to be close to
 * free; 60s makes it one read per school per minute however many tutors are
 * working. The lag is asymmetric and that is deliberate. Switching enforcement
 * ON applies up to a minute late, which is safe: tutors stay unrestricted a
 * little longer. Switching it OFF also applies up to a minute late, which is the
 * direction that hurts - a school that panic-disables it waits out the window
 * with its tutors still locked out. A minute is short enough to sit through and
 * long enough to be worth having; do not lengthen it without weighing that case.
 */
export function getSubjectAllocationEnforced(schoolId: string): Promise<boolean> {
  return unstable_cache(
    async () => {
      const snap = await adminDb.doc(`${RP.schools}/${schoolId}`).get();
      // Strict === true: absent, null and undefined all mean "not enforced".
      return snap.get("subjectAllocation") === true;
    },
    ["subject-allocation", schoolId],
    { revalidate: 60 }
  )();
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
  /**
   * The /s/{slug} link a school puts on the board. RESULTPEAK'S STORED SLUG
   * when it has one - see canonicalSchoolSlug.
   */
  slug: string;
  /**
   * The name-derived form, which STILL RESOLVES even when it is not canonical.
   *
   * This repo printed it on class sign-in sheets before ResultPeak's stored slug
   * was read here, and paper does not get recalled. Kept as an accepted alias so
   * a sheet sent home last term keeps working; never printed.
   */
  legacySlug: string;
}

/** The name-derived slug. A FALLBACK now - prefer canonicalSchoolSlug. */
export function schoolSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The slug to PRINT and to LINK WITH: ResultPeak's stored one, else derived.
 *
 * ============================================================================
 * RESULTPEAK OWNS THE SLUG. DERIVING ONE OVER A STORED VALUE IS THE BUG THIS
 * FIXES, AND IT WAS LIVE.
 * ============================================================================
 *
 * A school's slug is stored on `schools/{id}.slug` and reserved for uniqueness
 * in `schoolSlugs/{slug}`, both written by ResultPeak. This repo used to ignore
 * that and recompute the slug from the school's NAME on every read, which meant
 * the two products disagreed about a school's own address. Measured 2026-09-10,
 * they disagreed for three of the four schools in the project:
 *
 *   HIGHER GROUND INTERNATIONAL GROUP OF SCHOOL  stored "higher-ground"
 *                                                derived "higher-ground-international-group-of-school"
 *   Mt. Cedar British International School       stored "mt-cedar"
 *                                                derived "mt-cedar-british-international-school"
 *   Dlink Academy (ActiveBrains)                 no stored slug - derived is correct
 *   CAPSTONE ACADEMY                             both "capstone-academy"
 *
 * So every /s/{slug} link ResultPeak printed landed on this side's school
 * PICKER, unbranded, with no error anywhere - because an unknown slug is
 * designed to fall through to the picker. That is the same symptom as a link
 * pointing at the shared deployment, from an unrelated cause, and the two were
 * being reported together.
 *
 * A derived slug is still the answer for a school ResultPeak has not stored one
 * for, which is a real state and not a gap: Dlink has none today.
 */
export function canonicalSchoolSlug(stored: unknown, name: string): string {
  const clean = String(stored ?? "").trim().toLowerCase();
  return clean || schoolSlug(name);
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
        // ResultPeak's stored slug, which is what it prints and links with.
        slug: canonicalSchoolSlug(s.slug, s.name),
        // Derived from the RAW name, before the duplicate-name suffix above.
        legacySlug: schoolSlug(s.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  ["school-directory"],
  { revalidate: 21600 } // 6 hours
);

/**
 * Resolve a /s/{...} link by slug OR by raw school id.
 *
 * Replaced findSchoolBySlug(). One resolver, not two: a second entry point that
 * handled only slugs is how half the call sites keep the rename bug below.
 *
 * THE ID FORM IS NOT A CONVENIENCE, IT IS THE REPAIR FOR A SILENT FAILURE. The
 * slug is computed from the school's NAME every time it is read (schoolSlug
 * above), and nothing stores it. So the day an admin fixes a typo in their own
 * school name, every link that school has printed on a board, put on its
 * website or sent to parents stops resolving - with no error anywhere, because
 * an unknown slug is designed to fall through to the picker.
 *
 * A document id never changes, so /s/{schoolId} is a link that cannot rot. Both
 * forms work; a school can print either. THE STORED SLUG THAT FIX ASKED FOR HAS
 * SHIPPED and is now read here (canonicalSchoolSlug), and this stays regardless,
 * because links already in circulation do not get recalled.
 *
 * WHICH IS ALSO WHY THE NAME-DERIVED FORM STILL RESOLVES. It is no longer what
 * this repo prints, but it is what it printed on class sign-in sheets before the
 * stored slug was read, and a sheet that went home with a child last term has to
 * keep working. Matched second, so a stored slug always wins a collision, and
 * still through the "exactly one" guard below - an alias must never make two
 * schools answer to one link.
 *
 * Slug first: a slug is what a school is told to use, and an id that happened to
 * look like a slug should not shadow one.
 */
export async function findSchool(value: string): Promise<SchoolListing | null> {
  const directory = await getSchoolDirectory();
  const typed = value.toLowerCase();

  const bySlug = directory.filter((s) => s.slug === typed);
  if (bySlug.length === 1) return bySlug[0];

  const byLegacy = directory.filter((s) => s.legacySlug === typed);
  if (byLegacy.length === 1) return byLegacy[0];

  // Case-sensitive: Firestore ids are, and a case-folded compare here would
  // make two distinct ids collide.
  return directory.find((s) => s.id === value) ?? null;
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
