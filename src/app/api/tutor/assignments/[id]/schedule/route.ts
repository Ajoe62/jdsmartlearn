import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getTutorSession, assertClassAccess, assertDocumentSubjectAccess } from "@/lib/auth/tutor";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "@/lib/db/collections";
import { assertWritable } from "@/lib/db/write-guard";
import { classAssignmentsTag } from "@/lib/db/submissions";
import type { Assignment } from "@/types/student-dashboard";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getTutorSession();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const { opensAt, closesAt, dueDate, baseUpdatedAt } = body;
  if (![opensAt, closesAt, dueDate, baseUpdatedAt].every((n) => typeof n === "number" && Number.isSafeInteger(n)) || closesAt <= opensAt || dueDate > closesAt) {
    return NextResponse.json({ error: "Choose valid dates: the closing time must be after the opening time, and the due date must be on or before closing." }, { status: 400 });
  }
  assertWritable(JD.assignments);
  const ref = adminDb.collection(JD.assignments).doc(id);
  const result = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const a = snap.exists ? snap.data() as Assignment : null;
    if (!a || a.schoolId !== session.schoolId || (!session.isAdmin && a.tutorId !== session.uid)) return { status: 404, error: "Assignment not found." };
    if (a.term !== "Second Term") return { status: 400, error: "Scheduling edits are available only for Second Term assignments." };
    try { assertClassAccess(session, a.classId); assertDocumentSubjectAccess(session, a); } catch { return { status: 403, error: "You cannot edit this assignment." }; }
    if (a.updatedAt !== baseUpdatedAt) return { status: 409, error: "This assignment changed. Reload it before saving." };
    tx.update(ref, { opensAt, closesAt, dueDate, updatedAt: Date.now() });
    return { status: 200, classId: a.classId };
  });
  if (result.status !== 200) return NextResponse.json({ error: result.error }, { status: result.status });
  revalidateTag(classAssignmentsTag(result.classId!));
  return NextResponse.json({ ok: true });
}
