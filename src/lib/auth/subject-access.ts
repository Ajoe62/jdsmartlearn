// Pure subject-allocation judgement. NO "server-only" here and nothing imported
// at all, deliberately: this decides whether a tutor may act on a (class,
// subject) pair, and it is worth testing against the real function rather than a
// copy of it. Same treatment as src/lib/auth/claims.ts, and covered by the same
// module-boundary guard in scripts/test-offline.ts - it must never grow an
// import of firebase-admin, a secret, or anything under src/lib/db.
//
// It holds no secret and reads no environment. An allocation is data the caller
// already has.

/**
 * The slice of a tutor these checks need.
 *
 * Structural on purpose, so this module never imports TutorSession from
 * lib/auth/tutor - that file is `server-only` and importing it would break the
 * purity this module exists to keep. A TutorSession satisfies this shape.
 */
export interface SubjectAllocation {
  /** Admin-level actor. Unrestricted, exactly as they are for assignedClasses. */
  isAdmin: boolean;
  assignedSubjects: string[];
  /** subjectId -> classIds. */
  subjectClasses: Record<string, string[]>;
}

/**
 * The legacy state: this tutor has not been allocated subjects yet, so every
 * check must pass. Most tutors are here, and will be for a while.
 *
 * NOTE THE FIELDS THIS READS, because it is not the obvious way to write it.
 * ResultPeak's contract defines the legacy state as `assignments` being absent
 * or empty, and `assignments` is the authoritative field. This reads the DERIVED
 * fields instead - the same ones the checks below read.
 *
 * The two can disagree. A tutor whose `assignments` has been written but whose
 * `subjectClasses` has not yet been derived would, on the authoritative test,
 * count as allocated and then fail every lookup against an empty map - locking a
 * working account out of routes it can use today. Reading the fields the checks
 * actually use means a half-written profile falls back to current behaviour
 * instead.
 *
 * This fails OPEN, which is deliberate and bounded: assertClassAccess still runs
 * first at every call site, so the worst case is the class-only scoping that is
 * in production right now, never something wider.
 */
export function isUnallocated(allocation: SubjectAllocation): boolean {
  return (
    allocation.assignedSubjects.length === 0 ||
    Object.keys(allocation.subjectClasses).length === 0
  );
}

/** Whether this tutor teaches `subjectId` to `classId`. */
export function teachesSubjectInClass(
  allocation: SubjectAllocation,
  classId: string,
  subjectId: string
): boolean {
  if (allocation.isAdmin) return true;
  if (isUnallocated(allocation)) return true;
  return (allocation.subjectClasses[subjectId] ?? []).includes(classId);
}

/**
 * Whether this tutor teaches `subjectId` at all, in any class.
 *
 * For the one route that has no class to check against: POST /api/topics
 * creates a (subject, level, term) curriculum row, school-wide and shared by
 * every tutor, with no classId anywhere in the request.
 */
export function teachesSubject(
  allocation: SubjectAllocation,
  subjectId: string
): boolean {
  if (allocation.isAdmin) return true;
  if (isUnallocated(allocation)) return true;
  return allocation.assignedSubjects.includes(subjectId);
}

/**
 * The subjectId -> classIds map a picker should offer, narrowed to subjects the
 * school really has and classes the tutor really holds.
 *
 * Returns `{}` for an unallocated tutor and for an admin, which both callers
 * read as "no restriction, offer everything". Keeping that convention here
 * rather than in each form is what stops a picker inventing its own idea of the
 * legacy state.
 */
export function teachableMap(
  allocation: SubjectAllocation,
  schoolSubjectIds: string[],
  heldClassIds: string[]
): Record<string, string[]> {
  if (allocation.isAdmin || isUnallocated(allocation)) return {};

  const subjects = new Set(schoolSubjectIds);
  const classes = new Set(heldClassIds);
  const map: Record<string, string[]> = {};

  for (const [subjectId, classIds] of Object.entries(allocation.subjectClasses)) {
    if (!subjects.has(subjectId)) continue; // subject removed in ResultPeak
    const usable = classIds.filter((id) => classes.has(id));
    if (usable.length > 0) map[subjectId] = usable;
  }
  return map;
}

/**
 * The two picker directions, shared by the new-lesson and new-assignment forms.
 *
 * Both forms choose a class AND a subject interactively, so neither can be
 * pre-filtered on the server - the other field is not chosen yet. The server
 * hands down the map and these narrow it as the tutor picks.
 *
 * AN EMPTY MAP MEANS NO RESTRICTION in both, matching teachableMap() above.
 * Filtering is a convenience: every route re-checks the pair server-side.
 */

/** Subjects this tutor may pick for `classId`. All of them before a class is chosen. */
export function subjectsForClass<T extends { id: string }>(
  teachable: Record<string, string[]>,
  subjects: T[],
  classId: string
): T[] {
  if (Object.keys(teachable).length === 0 || !classId) return subjects;
  return subjects.filter((s) => (teachable[s.id] ?? []).includes(classId));
}

/** Classes this tutor may pick for `subjectId`. All of them before one is chosen. */
export function classesForSubject<T extends { id: string }>(
  teachable: Record<string, string[]>,
  classes: T[],
  subjectId: string
): T[] {
  if (Object.keys(teachable).length === 0 || !subjectId) return classes;
  const allowed = new Set(teachable[subjectId] ?? []);
  return classes.filter((c) => allowed.has(c.id));
}
