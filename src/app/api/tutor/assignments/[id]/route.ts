import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getTutorSession, assertClassAccess, assertDocumentSubjectAccess } from "@/lib/auth/tutor";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "@/lib/db/collections";
import { assertWritable } from "@/lib/db/write-guard";
import { classAssignmentsTag } from "@/lib/db/submissions";
import { writeAuditLog } from "@/lib/db/lessons";
import { deleteFile } from "@/lib/storage/provider";
import type { Assignment } from "@/types/student-dashboard";

type Outcome =
  | { status: 200; classId: string; fileKey?: string }
  | { status: 400 | 403 | 404 | 409; error: string; code?: string };

/**
 * Who may delete or hide an assignment: the tutor who set it, or a school
 * admin, and only for a class and subject they still have. Same checks as the
 * schedule route, read fresh on the request.
 */
function authorize(
  session: NonNullable<Awaited<ReturnType<typeof getTutorSession>>>,
  a: Assignment | null
): Outcome | null {
  if (!a || a.schoolId !== session.schoolId || (!session.isAdmin && a.tutorId !== session.uid)) {
    return { status: 404, error: "Assignment not found." };
  }
  try {
    assertClassAccess(session, a.classId);
    assertDocumentSubjectAccess(session, a);
  } catch {
    return { status: 403, error: "You don't teach that subject to that class." };
  }
  return null;
}

/**
 * Permanent delete, allowed ONLY while nobody has sent work.
 *
 * Once a submission exists it may carry marks, and a finalised mark may already
 * sit in `studentAcademicRecords`. Deleting the assignment would strand those
 * marks with nothing behind them, so the route refuses with 409 and the
 * interface offers "Hide from students" instead. Submissions are never deleted
 * from here.
 *
 * The submission check runs inside the transaction. One limited, two-equality
 * query: needs no composite index.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getTutorSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;

  assertWritable(JD.assignments);
  const ref = adminDb.collection(JD.assignments).doc(id);
  const result: Outcome = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const a = snap.exists ? (snap.data() as Assignment) : null;
    const denied = authorize(session, a);
    if (denied) return denied;
    const sent = await tx.get(
      adminDb
        .collection(JD.submissions)
        .where("schoolId", "==", session.schoolId)
        .where("assignmentId", "==", id)
        .limit(1)
    );
    if (!sent.empty) {
      return {
        status: 409,
        code: "has_submissions",
        error: "Students have already sent work for this assignment, so it can't be deleted. You can hide it from students instead.",
      };
    }
    tx.delete(ref);
    return { status: 200, classId: a!.classId, fileKey: a!.fileKey };
  });

  if (result.status !== 200) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  // Remove the question sheet too; an orphaned file is not worth failing the delete.
  if (result.fileKey) {
    try {
      await deleteFile(result.fileKey);
    } catch (err) {
      console.error(`assignment ${id}: deleting question sheet failed`, err);
    }
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "assignment.delete",
    entityId: id,
  });
  revalidateTag(classAssignmentsTag(result.classId));
  return NextResponse.json({ ok: true });
}

/**
 * Hide from students: sets `isActive: false`. Nothing is removed - submissions
 * and marks stay exactly as they are, and the tutor can still mark work.
 * Only `{ isActive: false }` is accepted; this is not a general edit route.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getTutorSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { isActive?: unknown };
  if (body.isActive !== false) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  assertWritable(JD.assignments);
  const ref = adminDb.collection(JD.assignments).doc(id);
  const result: Outcome = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const a = snap.exists ? (snap.data() as Assignment) : null;
    const denied = authorize(session, a);
    if (denied) return denied;
    tx.update(ref, { isActive: false, updatedAt: Date.now() });
    return { status: 200, classId: a!.classId };
  });

  if (result.status !== 200) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "assignment.hide",
    entityId: id,
  });
  revalidateTag(classAssignmentsTag(result.classId));
  return NextResponse.json({ ok: true });
}
