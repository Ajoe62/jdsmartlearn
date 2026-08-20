import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getLesson, getGeneratedContent } from "@/lib/db/lessons";
import { countLessonReaders } from "@/lib/db/lesson-views";
import { listClassesForSchool } from "@/lib/db/resultpeak";
import { formatBytes } from "@/lib/format";
import ReviewLesson from "./ReviewLesson";
import MaterialSection from "./MaterialSection";
import DeleteLesson from "./DeleteLesson";
import EditLessonSection from "./EditLessonSection";

/**
 * Review & publish - the mandatory teacher-review gate. Generated content is
 * never student-visible until a tutor publishes here. Marking guide is shown
 * only on this tutor screen. All authorization is re-checked server-side.
 */
export default async function LessonReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const lesson = await getLesson(id);
  if (!lesson || lesson.schoolId !== session.schoolId) notFound();
  try {
    assertClassAccess(session, lesson.classId);
  } catch {
    notFound(); // don't reveal lessons for classes this tutor doesn't teach
  }

  const anythingPublished = lesson.status === "published" || !!lesson.materialPublishedAt;
  const [content, readers, adminClasses] = await Promise.all([
    getGeneratedContent(id),
    anythingPublished
      ? countLessonReaders(id, session.schoolId)
      : Promise.resolve(0),
    // Only admins may move a lesson between classes; tutors get no options.
    session.isAdmin ? listClassesForSchool(session.schoolId) : Promise.resolve([]),
  ]);

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/tutor" className="text-sm text-muted">
        ← Your lessons
      </Link>
      <h1 className="mt-3 text-title">{lesson.title}</h1>
      <p className="mt-1 text-sm text-muted">
        {lesson.className}
        {anythingPublished && (
          <>
            {" · "}
            {readers === 0
              ? "no students have opened this yet"
              : readers === 1
                ? "1 student has opened this"
                : `${readers} students have opened this`}
          </>
        )}
      </p>

      <EditLessonSection
        lessonId={lesson.id}
        initialTitle={lesson.title}
        initialText={lesson.extractedText}
        initialClassId={lesson.classId}
        hasStudyGuide={!!content}
        anythingPublished={anythingPublished}
        classes={adminClasses.map((c) => ({ id: c.id, name: c.name }))}
      />

      <MaterialSection
        lessonId={lesson.id}
        materialText={lesson.extractedText}
        initialPublished={!!lesson.materialPublishedAt}
        file={
          lesson.fileKey && lesson.fileName
            ? { name: lesson.fileName, sizeLabel: formatBytes(lesson.fileSize ?? 0) }
            : null
        }
      />

      <h2 className="mt-10 text-heading">Study guide</h2>
      <p className="mt-1 text-sm text-muted">
        AI summary and practice questions, generated from the material. Publishes
        separately from the material above.
      </p>
      <ReviewLesson
        lessonId={lesson.id}
        status={lesson.status}
        content={
          content
            ? {
                summary: content.summary,
                questions: content.questions,
                markingGuide: content.markingGuide,
              }
            : null
        }
      />

      <DeleteLesson lessonId={lesson.id} lessonTitle={lesson.title} />
    </main>
  );
}
