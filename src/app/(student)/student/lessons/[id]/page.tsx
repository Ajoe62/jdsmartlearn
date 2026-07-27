import { notFound, redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getStudentLesson } from "@/lib/db/student-content";
import LessonReaderView from "@/components/student/LessonReaderView";

/**
 * A single lesson for a student: the raw material and/or the study guide, each
 * shown only when the tutor has published that part. getStudentLesson enforces
 * class/school scoping and drops the marking guide.
 *
 * The read receipt is NOT written here. It used to be a Firestore write on every
 * render, which a reconnect flood would have multiplied; the device now dedupes
 * to one receipt per lesson per day and flushes them in a batch (lib/offline/outbox).
 */
export default async function StudentLessonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const lesson = await getStudentLesson(session.schoolId, session.classId, id);
  if (!lesson) notFound();

  return <LessonReaderView lessonId={id} initial={lesson} />;
}
