import "server-only";
import { getClassSyncBundle } from "./student-content";
import { listActiveAssignmentsForClass } from "./assignments";
import { listSubmissionsForStudent } from "./submissions";
import { listPublishedSchemesForClass } from "./schemes";
import { getClassSubjects, isDerivedFromContentOnly } from "./class-subjects";
import { termOrder } from "@/lib/academic-calendar";
import {
  ALL_TERMS,
  buildShelf,
  shelfTotals,
  termOptions,
  type ShelfAssignment,
  type ShelfLesson,
  type ShelfScheme,
  type ShelfSubject,
  type ShelfSubmission,
  type ShelfTotals,
  type TermFilter,
  type TermOption,
} from "@/lib/shelf/build";

/**
 * Assemble one student's subject shelf.
 *
 * READS, AND WHAT EACH COSTS:
 *
 *   lessons      getClassSyncBundle - cached per class, shared by the whole class
 *   schemes      cached per class, shared by the whole class
 *   assignments  cached per class, shared by the whole class
 *   subjects     cached per school (allocation scan) + cached school document
 *   submissions  ONE query, per student - this is the only per-reader read
 *
 * So a class of thirty opening this at 8am costs four shared reads between them
 * plus one query each. That last one is irreducible: a child's own marks are
 * theirs, and there is nothing to share.
 *
 * NOTHING HERE TOUCHES RESULTPEAK'S `results` OR `studentAcademicRecords`. The
 * shelf shows JDSmartLearn's own record only, and links out for exams (CLAUDE.md,
 * Subject shelf rules). Restaging their marks here is how two products start
 * disagreeing about a child.
 */

export interface SubjectShelf {
  subjects: ShelfSubject[];
  totals: ShelfTotals;
  /** Pairs the student actually has work in, newest session first. */
  terms: TermOption[];
  /** The filter these numbers were built with. */
  filter: TermFilter;
  /** True when some of this class's work carries no term stamp at all. */
  hasUndated: boolean;
  /**
   * True when no tutor has been allocated to this class, so the subject list is
   * only what happens to have content and is probably short. The interface says
   * so in plain words rather than letting a child assume a subject was dropped.
   */
  subjectsIncomplete: boolean;
}

export async function getSubjectShelf(
  schoolId: string,
  classId: string,
  studentId: string,
  filter: TermFilter = ALL_TERMS
): Promise<SubjectShelf> {
  const [bundle, assignmentDocs, submissionDocs, schemeDocs] = await Promise.all([
    getClassSyncBundle(schoolId, classId),
    listActiveAssignmentsForClass(schoolId, classId),
    listSubmissionsForStudent(schoolId, studentId),
    listPublishedSchemesForClass(schoolId, classId),
  ]);

  const lessons: ShelfLesson[] = bundle.map((l) => ({
    lessonId: l.lessonId,
    subjectId: l.subjectId,
    hasMaterial: l.hasMaterial,
    hasStudyGuide: l.hasStudyGuide,
    term: l.term,
    session: l.session,
  }));

  const assignments: ShelfAssignment[] = assignmentDocs.map((a) => ({
    assignmentId: a.id,
    subjectId: a.subjectId,
    dueDate: a.dueDate,
    term: a.term,
    session: a.session,
  }));

  const schemes: ShelfScheme[] = schemeDocs.map((s) => ({
    schemeId: s.id,
    subjectId: s.subjectId,
    term: s.term,
    session: s.session,
  }));

  /**
   * Percentages, computed HERE and only from finalised submissions.
   *
   * `finalScore` is null at every status except `finalised` - that is enforced by
   * `toStudentSubmissionPayload`, and the `isFinalised` flag below is what the
   * shelf reads rather than re-deriving a release rule of its own.
   *
   * A subject's mean is only ever taken within one filter. There is no annual
   * figure here and there must never be one: that arithmetic is ResultPeak's
   * (CLAUDE.md, Assessment rules).
   */
  const submissions: ShelfSubmission[] = submissionDocs.map((s) => ({
    assignmentId: s.assignmentId,
    subjectId: s.subjectId,
    isFinalised: s.status === "finalised",
    finalScorePercent:
      s.status === "finalised" && typeof s.finalScore === "number" && s.maxMarks > 0
        ? Math.round((s.finalScore / s.maxMarks) * 100)
        : null,
  }));

  // Every subject with something in it, whatever term it was in - the shelf's
  // ROW SET must not shrink when the filter narrows, or a child switching to
  // "This term" would watch subjects disappear rather than empty.
  const observed = new Set<string>([
    ...lessons.map((l) => l.subjectId),
    ...assignments.map((a) => a.subjectId),
    ...schemes.map((s) => s.subjectId),
  ]);

  const classSubjects = await getClassSubjects(schoolId, classId, observed);

  const dated = [...lessons, ...assignments, ...schemes];

  // Built ONCE and summed. Building twice would let the header disagree with the
  // list under it the moment a due date passed between the two calls.
  const subjects = buildShelf({
    subjects: classSubjects.map((s) => ({ id: s.id, name: s.name })),
    lessons,
    assignments,
    submissions,
    schemes,
    filter,
    now: Date.now(),
  });

  return {
    subjects,
    totals: shelfTotals(subjects),
    terms: termOptions(dated, termOrder),
    filter,
    hasUndated: dated.some((r) => r.term === null || r.session === null),
    subjectsIncomplete: isDerivedFromContentOnly(classSubjects),
  };
}

/**
 * Parse `?term=` and `?session=` into a filter.
 *
 * VALIDATED AGAINST THE STUDENT'S OWN OBSERVED PAIRS, not against a list of
 * known terms. A pair nobody has work in resolves to "all" rather than to an
 * empty screen, and a hand-edited query string cannot conjure a filter that
 * matches nothing. Strings are compared verbatim - never trimmed, never case
 * folded.
 */
export function parseTermFilter(
  term: string | undefined,
  session: string | undefined,
  available: TermOption[]
): TermFilter {
  if (!term || !session) return ALL_TERMS;
  const known = available.some((o) => o.term === term && o.session === session);
  return known ? { kind: "pair", term, session } : ALL_TERMS;
}
