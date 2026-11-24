import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTutorSession, assertClassAccess, assertDocumentSubjectAccess } from "@/lib/auth/tutor";
import { getAssignment } from "@/lib/db/assignments";
import ScheduleForm from "./ScheduleForm";

export default async function EditAssignment({ params }: { params: Promise<{ assignmentId: string }> }) {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");
  const { assignmentId } = await params;
  const assignment = await getAssignment(assignmentId);
  if (!assignment || assignment.schoolId !== session.schoolId || (!session.isAdmin && assignment.tutorId !== session.uid)) notFound();
  try { assertClassAccess(session, assignment.classId); assertDocumentSubjectAccess(session, assignment); } catch { notFound(); }
  return <main className="mx-auto max-w-readable px-5 py-10">
    <Link href={`/tutor/assignments/${assignmentId}/submissions`} className="text-sm text-muted">Back to assignment</Link>
    <h1 className="mt-3 text-title">Edit assignment schedule</h1>
    <p className="mt-2">{assignment.title} · {assignment.className} · {assignment.subjectName}</p>
    <ScheduleForm id={assignmentId} opensAt={assignment.opensAt ?? null} closesAt={assignment.closesAt ?? null} dueDate={assignment.dueDate} updatedAt={assignment.updatedAt} />
  </main>;
}
