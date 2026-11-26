import "server-only";
import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import { listActiveAssignmentsForClass } from "./assignments";
import { getCurrentTermSession } from "./school-settings";
import { reportIfCapped } from "@/lib/list-cap";
import { isAssignmentVisibleToStudent } from "@/lib/assignments/availability";

/**
 * Re-exported from the pure modules so callers keep one import, while the rules
 * that decide a child's report-card number, and the projection that decides what
 * reaches their phone at all, stay directly testable.
 *
 * Nothing here re-implements them. `toStudentSubmissionPayload` in particular
 * lives in `assessment/projection.ts` beside `toStudentAssignment`, because the
 * two enforce the same guarantee and a reader checking one should find the other
 * in the same file.
 */
export { averagePercentage, denormalizedFrom } from "@/lib/assessment/ca";
export { linkTopics, toStudentSubmissionPayload } from "@/lib/assessment/projection";
import type {
  AssignmentListItem,
  AssignmentSubmission,
} from "@/types/student-dashboard";
import type { CaSyncRecord } from "@/lib/assessment/marking";

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

/**
 * Server-side only. Scores never arrive from a client.
 *
 * UNCONDITIONAL. Use it only where nothing else can be writing the same
 * submission. Anything that reads, does slow work, then writes (AI marking, the
 * sweep, a tutor's release) must use `updateSubmissionWhen` instead, or it can
 * overwrite a decision made in the meantime. See lib/assessment/marking.ts.
 */
export async function updateSubmission(
  id: string,
  patch: Partial<AssignmentSubmission>
): Promise<void> {
  assertWritable(JD.submissions);
  await adminDb.doc(`${JD.submissions}/${id}`).update({ ...patch, updatedAt: Date.now() });
}

/**
 * Apply `patch` only if the submission, read INSIDE the same transaction, still
 * passes `when`. Returns whether it was written.
 *
 * This is the fix for the release race: the check and the write happen
 * together, so a tutor's release between an AI writer's first read and its write
 * makes the AI write a no-op instead of an overwrite. Firestore retries the
 * transaction if the document changes under it, so `when` always judges the
 * newest copy.
 */
export async function updateSubmissionWhen(
  id: string,
  when: (current: AssignmentSubmission) => boolean,
  patch: Partial<AssignmentSubmission>
): Promise<boolean> {
  assertWritable(JD.submissions);
  const ref = adminDb.doc(`${JD.submissions}/${id}`);
  return adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const current = { id: snap.id, ...snap.data() } as AssignmentSubmission;
    if (!when(current)) return false;
    tx.update(ref, { ...patch, updatedAt: Date.now() });
    return true;
  });
}

/**
 * Record whether a released mark reached the report card.
 *
 * Does NOT move `updatedAt`, deliberately. `updatedAt` is the version a tutor's
 * marking request is checked against; this is bookkeeping about a send that
 * already happened, and bumping it would turn the tutor's next action into a
 * false "changed since you marked it".
 */
export async function recordCaSync(id: string, record: CaSyncRecord): Promise<void> {
  assertWritable(JD.submissions);
  await adminDb.doc(`${JD.submissions}/${id}`).update({ caSync: record });
}

/**
 * One student's own work, in ONE school year. Equality filters only, no
 * orderBy, so no composite index (verified against the live project on
 * 2026-11-26).
 *
 * This used to read at most 50 across every year with no ordering, so once a
 * child had sent more than 50 pieces of work an arbitrary set dropped out: work
 * they had sent showed as not done, and their subject percentages were taken
 * over whatever happened to come back. Now per school year with the full query
 * limit, and a full result is logged. Same reasoning as
 * listActiveAssignmentsForClass, and the two must use the same `session`, or a
 * child's work and the assignments it answers stop lining up.
 *
 * Null `session` (no term set in School profile) reads without the year filter.
 */
export async function listSubmissionsForStudent(
  schoolId: string,
  studentId: string,
  session: string | null
) {
  let q = adminDb
    .collection(JD.submissions)
    .where("schoolId", "==", schoolId)
    .where("studentId", "==", studentId);
  if (session) q = q.where("session", "==", session);
  const snap = await q.limit(QUERY_LIMIT).get();
  reportIfCapped(snap.docs, "student submissions", QUERY_LIMIT, { schoolId, studentId, session });
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
  // Every column. The caller narrows to one with marksForColumn(), which groups
  // by the column a mark actually lands in.
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AssignmentSubmission);
}

// ---------------------------------------------------------------------------
// Student projections
// ---------------------------------------------------------------------------

export const classAssignmentsTag = (classId: string) => `class-assignments:${classId}`;

const REVALIDATE_SECONDS = 300;

/**
 * Active assignments for a class, cached and shared by every student in it,
 * together with the school year they were read for.
 *
 * Same quota mechanism as getClassSyncBundle: thirty students opening the
 * assignment list at break cost ONE Firestore query between them, plus one
 * read of the school document for the year, also shared.
 *
 * The `session` comes back WITH the list so each student's own submissions are
 * read for the same year without a second school read per student. It is the
 * value the list was built with, at most one revalidate window old.
 *
 * Marking guides are stripped inside the cache, so no guide is ever held in a
 * cache entry that a student request can reach.
 */
export function getClassAssignments(schoolId: string, classId: string) {
  return unstable_cache(
    async () => {
      const calendar = await getCurrentTermSession(schoolId);
      const session = calendar?.session ?? null;
      // Cache candidates, never a time-filtered result: an assignment must
      // appear exactly when it opens and disappear exactly when it closes,
      // rather than at the next cache revalidation.
      const assignments = await listActiveAssignmentsForClass(
        schoolId,
        classId,
        session,
        Date.now(),
        true
      );
      return {
        session,
        assignments: assignments.map((a) => ({
          assignmentId: a.id,
          title: a.title,
          subjectId: a.subjectId,
          subjectName: a.subjectName,
          type: a.type,
          dueDate: a.dueDate,
          maxMarks: a.maxMarks,
          term: a.term,
          session: a.session,
          opensAt: a.opensAt ?? null,
          closesAt: a.closesAt ?? null,
          isActive: a.isActive,
        })),
      };
    },
    // The key changed shape on 2026-11-26 (it now returns the session too), so
    // a cache entry written by the previous build can never be read as this one.
    ["class-assignments-v2", schoolId, classId],
    { revalidate: REVALIDATE_SECONDS, tags: [classAssignmentsTag(classId)] }
  );
}

/**
 * A student's visible assignments AND their own submissions for the same year,
 * from one cached class query and ONE per-student query.
 *
 * The phone's sync needs both. It used to call buildAssignmentList and then
 * read the student's submissions a second time; this returns the rows already
 * read so no caller has a reason to read them again.
 */
export async function loadAssignmentsForStudent(
  schoolId: string,
  classId: string,
  studentId: string
): Promise<{ items: AssignmentListItem[]; submissions: AssignmentSubmission[]; session: string | null }> {
  const { session, assignments } = await getClassAssignments(schoolId, classId)();
  const submissions = await listSubmissionsForStudent(schoolId, studentId, session);
  return { items: toAssignmentList(assignments, submissions), submissions, session };
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
  return (await loadAssignmentsForStudent(schoolId, classId, studentId)).items;
}

type ClassAssignment = Awaited<ReturnType<ReturnType<typeof getClassAssignments>>>["assignments"][number];

function toAssignmentList(
  assignments: ClassAssignment[],
  submissions: AssignmentSubmission[]
): AssignmentListItem[] {
  const byAssignment = new Map(submissions.map((s) => [s.assignmentId, s]));
  const now = Date.now();

  const items: AssignmentListItem[] = assignments
    .filter((a) => isAssignmentVisibleToStudent(a, Date.now()))
    .map((a) => {
    const sub = byAssignment.get(a.assignmentId) ?? null;
    const finalScore = sub?.status === "finalised" ? sub.finalScore : null;
    return {
      assignmentId: a.assignmentId,
      opensAt: a.opensAt,
      closesAt: a.closesAt,
      title: a.title,
      subjectId: a.subjectId,
      subjectName: a.subjectName,
      type: a.type,
      dueDate: a.dueDate,
      maxMarks: a.maxMarks,
      term: a.term,
      session: a.session,
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



