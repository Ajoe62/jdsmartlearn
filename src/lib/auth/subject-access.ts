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
  /**
   * The SCHOOL's enforcement flag - `schools/{id}.subjectAllocation`, absent
   * meaning off. Not a property of the tutor, which is why it is easy to get
   * backwards. See the truth table above teachesSubjectInClass().
   */
  subjectAllocationEnforced: boolean;
}

/**
 * This tutor has no usable allocation.
 *
 * WHAT THIS MEANS DEPENDS ENTIRELY ON THE SCHOOL FLAG, and this function
 * deliberately does not know about the flag - it reports a fact about the tutor
 * and lets the callers below decide what it costs. With enforcement off it means
 * "unrestricted, as every tutor was before this feature"; with enforcement on it
 * means "authors nothing until an admin allocates them".
 *
 * NOTE THE FIELDS THIS READS, because it is not the obvious way to write it.
 * ResultPeak's contract defines the legacy state as `assignments` being absent
 * or empty, and `assignments` is the authoritative field. This reads the DERIVED
 * fields instead - the same ones the checks below read.
 *
 * The two can disagree, in exactly one direction that matters: a tutor whose
 * `assignments` has been written but whose `subjectClasses` has not yet been
 * derived. On the authoritative test they count as allocated and then fail every
 * lookup against an empty map. Reading the fields the checks actually use keeps
 * that half-written profile in ONE state rather than two disagreeing ones.
 *
 * Under enforcement that state is a LOCKOUT, by an explicit decision: a
 * half-written profile waits for ResultPeak's derive step to finish rather than
 * falling back to permissive. That makes the derive step load-bearing. It is the
 * right way round - a school that has switched enforcement on has said it wants
 * pairs checked, and "we could not read your allocation" is not a reason to stop
 * checking - but it means a stalled derive is a support call, not a silent
 * widening. Nobody is in that state today; every allocated tutor in the project
 * has both fields consistent with `assignments`.
 */
export function isUnallocated(allocation: SubjectAllocation): boolean {
  return (
    allocation.assignedSubjects.length === 0 ||
    Object.keys(allocation.subjectClasses).length === 0
  );
}

/**
 * A tutor who can author nothing until somebody allocates them.
 *
 * Only possible under enforcement. Worth its own name because the PICKERS need
 * it: `teachableMap` returns `{}` for an unallocated tutor and every caller
 * reads `{}` as "no restriction, offer everything", which is exactly wrong here
 * - it would offer a full subject list to someone whose every submission is
 * about to be refused. Pages test this first and render an empty state that
 * names the fix (ask your admin) instead of a picker that cannot work.
 */
export function isAwaitingAllocation(allocation: SubjectAllocation): boolean {
  if (allocation.isAdmin) return false;
  return allocation.subjectAllocationEnforced && isUnallocated(allocation);
}

/**
 * Whether this tutor teaches `subjectId` to `classId`.
 *
 * THERE ARE TWO SWITCHES HERE AND THEY ANSWER DIFFERENT QUESTIONS. The school
 * flag decides whether subject checks apply at all; the tutor's own allocation
 * decides what passes once they do. Collapsing them into one test gets two of
 * the four rows wrong:
 *
 *   flag off + no allocation   -> allow    (every school today)
 *   flag off + allocated       -> ALLOW    (pickers narrow; routes must not refuse)
 *   flag on  + allocated       -> check the pair
 *   flag on  + no allocation   -> REFUSE   (not "allow everything")
 *
 * Row 2 is why `subjectAllocationEnforced` is tested before `isUnallocated`:
 * narrowing a picker is a convenience a school gets for free by allocating its
 * tutors, and it must never turn into a refusal that nobody switched on. Row 4
 * is the reason the flag exists at all - without it an unallocated tutor is
 * indistinguishable from a school that predates the feature.
 *
 * Always call assertClassAccess first. This narrows that check, never replaces
 * it, so the widest this can ever be is the class-only scoping already in
 * production.
 */
export function teachesSubjectInClass(
  allocation: SubjectAllocation,
  classId: string,
  subjectId: string
): boolean {
  if (allocation.isAdmin) return true;
  if (!allocation.subjectAllocationEnforced) return true;
  if (isUnallocated(allocation)) return false;
  return (allocation.subjectClasses[subjectId] ?? []).includes(classId);
}

/**
 * Whether this tutor teaches `subjectId` at all, in any class.
 *
 * For the one route that has no class to check against: POST /api/topics
 * creates a (subject, level, term) curriculum row, school-wide and shared by
 * every tutor, with no classId anywhere in the request.
 *
 * Same four rows as teachesSubjectInClass, against `assignedSubjects`.
 */
export function teachesSubject(
  allocation: SubjectAllocation,
  subjectId: string
): boolean {
  if (allocation.isAdmin) return true;
  if (!allocation.subjectAllocationEnforced) return true;
  if (isUnallocated(allocation)) return false;
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
 *
 * DELIBERATELY IGNORES `subjectAllocationEnforced`, and that asymmetry with the
 * checks above is the intended behaviour, not an oversight. Narrowing a picker
 * to the subjects a tutor actually teaches is a convenience that should apply as
 * soon as ResultPeak has allocated them, whether or not their school has
 * switched enforcement on - showing a teacher 36 subjects they do not teach is
 * the complaint this feature exists to fix, and it does not become worth fixing
 * only when a flag flips.
 *
 * The one case it cannot express is enforcement + no allocation, where `{}`
 * would offer everything to someone who may author nothing. Callers test
 * isAwaitingAllocation() BEFORE reaching for this map, and render an empty state
 * instead of a picker.
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
