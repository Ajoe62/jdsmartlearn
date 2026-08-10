import "server-only";
import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD, LIST_LIMIT, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import { listActiveAssignmentsForClass } from "./assignments";

/**
 * Re-exported from the pure module so callers keep one import, while the rules
 * that decide a child's report-card number stay directly testable.
 */
export { averagePercentage, denormalizedFrom } from "@/lib/assessment/ca";
import type {
  AssignmentListItem,
  AssignmentSubmission,
  AttachmentLink,
  StudentSubmissionView,
  TopicLink,
} from "@/types/student-dashboard";

/**
 * Submissions: one flat document per student per assignment.
 *
 * The id is deterministic, `${assignmentId}_${studentId}`, which is what makes
 * "has this student already submitted?" a single get rather than a query, and
 * makes a replayed offline flush idempotent instead of duplicating a child's work.
 */

export function submissionId(assignmentId: string, studentId: string): string {
  return `${assignmentId}_${studentId}`;
}

export async function getSubmission(id: string): Promise<AssignmentSubmission | null> {
  const snap = await adminDb.doc(`${JD.submissions}/${id}`).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as AssignmentSubmission) : null;
}

/**
 * Write a submission at its deterministic id, failing if one already exists.
 *
 * `create()` rather than `set()`: a double-tapped Submit button, or a Background
 * Sync replay of the same queued op, must not overwrite work that is already in
 * and possibly already marked. The caller turns the thrown ALREADY_EXISTS into
 * "You have already submitted this."
 */
export async function createSubmission(
  data: Omit<AssignmentSubmission, "id">
): Promise<void> {
  assertWritable(JD.submissions);
  await adminDb.doc(`${JD.submissions}/${submissionId(data.assignmentId, data.studentId)}`).create(data);
}

/** Server-side only. Scores never arrive from a client. */
export async function updateSubmission(
  id: string,
  patch: Partial<AssignmentSubmission>
): Promise<void> {
  assertWritable(JD.submissions);
  await adminDb.doc(`${JD.submissions}/${id}`).update({ ...patch, updatedAt: Date.now() });
}

/** Two equality filters, no orderBy. Needs NO composite index. */
export async function listSubmissionsForStudent(schoolId: string, studentId: string) {
  const snap = await adminDb
    .collection(JD.submissions)
    .where("schoolId", "==", schoolId)
    .where("studentId", "==", studentId)
    .limit(LIST_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as AssignmentSubmission)
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

/** Every submission on one assignment, for the tutor's review table. */
export async function listSubmissionsForAssignment(schoolId: string, assignmentId: string) {
  const snap = await adminDb
    .collection(JD.submissions)
    .where("schoolId", "==", schoolId)
    .where("assignmentId", "==", assignmentId)
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as AssignmentSubmission)
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

/**
 * Finalised marks for one student, in one subject, in one term OF ONE SESSION.
 *
 * The session filter is not optional. A Nigerian school year runs across two
 * calendar years and ResultPeak's own session default returns the next session
 * for eight months of it, so "Third Term" exists under more than one session
 * string in the same school's live data. Filtering on term alone would average a
 * child's third term across two academic years and the error would grow quietly
 * rather than fail.
 *
 * Six equality filters and no range, so still no composite index. `term` and
 * `session` are stored on the submission for exactly this reason.
 */
export async function listFinalisedForSubject(
  schoolId: string,
  studentId: string,
  subjectId: string,
  term: string,
  session: string
) {
  const snap = await adminDb
    .collection(JD.submissions)
    .where("schoolId", "==", schoolId)
    .where("studentId", "==", studentId)
    .where("subjectId", "==", subjectId)
    .where("term", "==", term)
    .where("session", "==", session)
    .where("status", "==", "finalised")
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AssignmentSubmission);
}

// ---------------------------------------------------------------------------
// Student projections
// ---------------------------------------------------------------------------

export const classAssignmentsTag = (classId: string) => `class-assignments:${classId}`;

const REVALIDATE_SECONDS = 300;

/**
 * Active assignments for a class, cached and shared by every student in it.
 *
 * Same quota mechanism as getClassSyncBundle: thirty students opening the
 * assignment list at break cost ONE Firestore query between them. The per-student
 * submissions query cannot be shared, but it is small and bounded.
 *
 * Marking guides are stripped inside the cache, so no guide is ever held in a
 * cache entry that a student request can reach.
 */
export function getClassAssignments(schoolId: string, classId: string) {
  return unstable_cache(
    async () => {
      const assignments = await listActiveAssignmentsForClass(schoolId, classId);
      return assignments.map((a) => ({
        assignmentId: a.id,
        title: a.title,
        subjectId: a.subjectId,
        subjectName: a.subjectName,
        type: a.type,
        dueDate: a.dueDate,
        maxMarks: a.maxMarks,
      }));
    },
    ["class-assignments", schoolId, classId],
    { revalidate: REVALIDATE_SECONDS, tags: [classAssignmentsTag(classId)] }
  );
}

/**
 * The student's three tabs, built from one cached class query plus one query for
 * their own submissions. Never fans out per assignment.
 *
 * Pending is "active, not submitted". A submitted assignment leaves Pending even
 * when it is overdue, because there is nothing left for the student to do.
 */
export async function buildAssignmentList(
  schoolId: string,
  classId: string,
  studentId: string
): Promise<AssignmentListItem[]> {
  const [assignments, submissions] = await Promise.all([
    getClassAssignments(schoolId, classId)(),
    listSubmissionsForStudent(schoolId, studentId),
  ]);

  const byAssignment = new Map(submissions.map((s) => [s.assignmentId, s]));
  const now = Date.now();

  const items: AssignmentListItem[] = assignments.map((a) => {
    const sub = byAssignment.get(a.assignmentId) ?? null;
    const finalScore = sub?.status === "finalised" ? sub.finalScore : null;
    return {
      assignmentId: a.assignmentId,
      title: a.title,
      subjectId: a.subjectId,
      subjectName: a.subjectName,
      type: a.type,
      dueDate: a.dueDate,
      maxMarks: a.maxMarks,
      status: sub?.status ?? null,
      submittedAt: sub?.submittedAt ?? null,
      finalScore,
      percentage:
        finalScore === null || a.maxMarks === 0
          ? null
          : Math.round((finalScore / a.maxMarks) * 100),
      isOverdue: sub === null && a.dueDate < now,
    };
  });

  return items.sort((a, b) => a.dueDate - b.dueDate);
}

/**
 * Build the download links for a submission's attachments.
 *
 * The stored value is an R2 key. It is never handed to a client: the href points
 * at a route on this origin that re-checks the session, the schoolId and the
 * ownership of the submission on every request.
 */
function toAttachmentLinks(
  sub: Pick<AssignmentSubmission, "assignmentId" | "attachments">
): AttachmentLink[] {
  return sub.attachments.map((a, index) => ({
    name: a.name,
    type: a.type,
    size: a.size,
    href: `/api/student/assignments/${sub.assignmentId}/attachments/${index}`,
  }));
}

/**
 * THE student-safe projection of a submission.
 *
 * Two guarantees, both by construction rather than by care:
 *
 *  1. No marking guide. This function never receives the assignment's guide, and
 *     `StudentSubmissionView` has no field one could occupy.
 *  2. No AI result before the tutor releases it. Every graded field is null
 *     unless status is "finalised". A high-confidence AI mark is still an
 *     unreviewed mark, and teacher review before release is mandatory
 *     (CLAUDE.md, Assessment rules).
 */
export function toStudentSubmissionPayload(
  sub: AssignmentSubmission,
  topicLinks: TopicLink[] = []
): StudentSubmissionView {
  const released = sub.status === "finalised";

  return {
    assignmentId: sub.assignmentId,
    assignmentTitle: sub.assignmentTitle,
    subjectName: sub.subjectName,
    submittedAt: sub.submittedAt,
    status: sub.status,
    content: sub.content,
    attachments: toAttachmentLinks(sub),
    maxMarks: sub.maxMarks,

    finalScore: released ? sub.finalScore : null,
    finalisedAt: released ? sub.finalisedAt : null,
    feedback: released ? sub.aiFeedback : null,
    strengths: released ? sub.aiStrengths : null,
    improvements: released ? sub.aiImprovements : null,
    topicsToRevise: released ? topicLinks : null,
    topicsMastered: released ? sub.topicsMastered : null,
    teacherComment: released ? sub.teacherComment : null,
  };
}

/**
 * Match each topic to a published lesson in the same subject, so "topics to
 * revise" leads somewhere instead of naming a gap.
 *
 * Case-insensitive exact title match only. A fuzzy match that sends a child to
 * the wrong lesson is worse than plain text, and `lessonId: null` renders as
 * plain text by design.
 */
export function linkTopics(
  topics: string[],
  lessons: { id: string; title: string; subjectId: string }[],
  subjectId: string
): TopicLink[] {
  const inSubject = lessons.filter((l) => l.subjectId === subjectId);
  const byTitle = new Map(inSubject.map((l) => [l.title.trim().toLowerCase(), l.id]));
  return topics.map((topic) => ({
    topic,
    lessonId: byTitle.get(topic.trim().toLowerCase()) ?? null,
  }));
}


