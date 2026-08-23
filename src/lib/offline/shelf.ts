/**
 * Read the device store into the shape `buildShelf()` wants.
 *
 * This is the whole of the offline shelf. There is no second implementation of
 * the counting, the filtering or the averaging: this function only reshapes
 * IndexedDB rows, and `buildShelf` - pure, tested, and the same function the
 * server calls - does the rest.
 *
 * Returns null when there is no device store at all (private mode, an old
 * browser), so the caller keeps whatever the server rendered.
 */

import { STORE, getAll } from "./db";
import type {
  StoredAssignment,
  StoredLesson,
  StoredScheme,
  StoredSubmission,
} from "./db";
import type {
  ShelfAssignment,
  ShelfLesson,
  ShelfScheme,
  ShelfSubmission,
} from "@/lib/shelf/build";

export interface ShelfInputs {
  subjects: { id: string; name: string }[];
  lessons: ShelfLesson[];
  assignments: ShelfAssignment[];
  submissions: ShelfSubmission[];
  schemes: ShelfScheme[];
}

export async function readShelfInputs(): Promise<ShelfInputs | null> {
  let lessonRows: StoredLesson[];
  let assignmentRows: StoredAssignment[];
  let submissionRows: StoredSubmission[];
  let schemeRows: StoredScheme[];

  try {
    [lessonRows, assignmentRows, submissionRows, schemeRows] = await Promise.all([
      getAll<StoredLesson>(STORE.lessons),
      getAll<StoredAssignment>(STORE.assignments),
      getAll<StoredSubmission>(STORE.submissions),
      getAll<StoredScheme>(STORE.schemes),
    ]);
  } catch {
    return null;
  }

  const lessons: ShelfLesson[] = lessonRows.map((l) => ({
    lessonId: l.lessonId,
    subjectId: l.subjectId,
    hasMaterial: l.hasMaterial,
    hasStudyGuide: l.hasStudyGuide,
    term: l.term ?? null,
    session: l.session ?? null,
  }));

  const assignments: ShelfAssignment[] = assignmentRows.map((a) => ({
    assignmentId: a.assignmentId,
    subjectId: a.subjectId,
    dueDate: a.dueDate,
    term: a.term ?? null,
    session: a.session ?? null,
  }));

  /**
   * A submission carries no subjectId on the device, so it is joined through the
   * assignment it answers. One that has no assignment left - the tutor switched
   * it off - is DROPPED rather than kept with a blank subject: it would count
   * toward a subject's average without ever appearing in its list.
   */
  const subjectByAssignment = new Map(
    assignmentRows.map((a) => [a.assignmentId, a.subjectId])
  );

  const submissions: ShelfSubmission[] = submissionRows.flatMap((s) => {
    const subjectId = subjectByAssignment.get(s.assignmentId);
    if (!subjectId) return [];
    const isFinalised = s.status === "finalised";
    return [
      {
        assignmentId: s.assignmentId,
        subjectId,
        isFinalised,
        // finalScore is null at every status but `finalised` - the server's
        // projection guarantees it, and this must not re-derive a release rule.
        finalScorePercent:
          isFinalised && s.finalScore !== null && s.maxMarks > 0
            ? Math.round((s.finalScore / s.maxMarks) * 100)
            : null,
      },
    ];
  });

  const schemes: ShelfScheme[] = schemeRows.map((s) => ({
    schemeId: s.schemeId,
    subjectId: s.subjectId,
    term: s.term,
    session: s.session,
  }));

  /**
   * The subject list, derived on the device from whatever it holds.
   *
   * NARROWER THAN THE SERVER'S, and knowingly so: the server also folds in tutor
   * allocations, which the device has no copy of and must not - an allocation is
   * authorization-adjacent data read fresh per request (CLAUDE.md, Tutor
   * offline). So a subject with an allocated tutor and nothing published shows
   * on the online shelf and not on the offline one. That is the right way round:
   * offline shows what this phone actually has.
   */
  const names = new Map<string, string>();
  for (const l of lessonRows) names.set(l.subjectId, l.subjectName);
  for (const a of assignmentRows) if (!names.has(a.subjectId)) names.set(a.subjectId, a.subjectName);
  for (const s of schemeRows) if (!names.has(s.subjectId)) names.set(s.subjectId, s.subjectName);

  return {
    subjects: [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    lessons,
    assignments,
    submissions,
    schemes,
  };
}
