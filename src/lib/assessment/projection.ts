/**
 * THE two student-safe projections, and nothing else.
 *
 * PURE. No Firestore, no `server-only`, no `next/*`, for the same reason as
 * `ca.ts`: these are the functions that decide what a child's phone is allowed
 * to receive, so they must be testable directly rather than only through a route
 * handler. `db/assignments.ts` and `db/submissions.ts` re-export them, so every
 * caller keeps one import and nothing is duplicated.
 *
 * TWO GUARANTEES, BOTH BY CONSTRUCTION RATHER THAN BY CARE:
 *
 *  1. No marking guide. Each function NAMES every field it copies instead of
 *     spreading its source, and the target interfaces have no field a guide
 *     could occupy. Adding a field to `Assignment` therefore cannot leak it;
 *     someone would have to come here and write the line.
 *
 *  2. No AI result before a tutor releases it. Gated on `status === "finalised"`
 *     and nothing else. A high-confidence AI mark is still an unreviewed mark
 *     (CLAUDE.md, Assessment rules).
 */

import { resolveAllowedFileTypes } from "@/lib/storage/file-types";
import type {
  Assignment,
  AssignmentSubmission,
  AttachmentLink,
  StudentAssignment,
  StudentSubmissionView,
  TopicLink,
} from "@/types/student-dashboard";

/**
 * The student-safe projection of an assignment.
 *
 * Names every field rather than spreading `Assignment`, so `markingGuide` cannot
 * be copied in by accident. This is the same defence as toStudentPayload() on
 * lessons, and it is the only way an assignment may reach a student device or a
 * student response.
 */
export function toStudentAssignment(a: Assignment): StudentAssignment {
  return {
    assignmentId: a.id,
    title: a.title,
    description: a.description,
    subjectId: a.subjectId,
    subjectName: a.subjectName,
    type: a.type,
    dueDate: a.dueDate,
    maxMarks: a.maxMarks,
    linkedLessonId: a.linkedLessonId,
    // Resolved HERE, once. A null on the document means "the tutor never chose",
    // and every student surface downstream gets a concrete list instead of
    // having to decide for itself what a missing value meant.
    allowedFileTypes: resolveAllowedFileTypes(a.allowedFileTypes),
    revision: a.updatedAt,
  };
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
 * `released` is a POSITIVE test against the one status that may show a score,
 * never a list of the statuses that may not. That is what makes it fail closed:
 * a status added later, or read from a device store written by a different
 * build, withholds the mark rather than exposing it because nobody remembered to
 * add it to a denylist. `ai_grading_failed` and any future stuck state are
 * covered by that property, not by being enumerated here.
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
