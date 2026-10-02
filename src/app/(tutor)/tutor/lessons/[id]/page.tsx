import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Callout from "@/components/ui/Callout";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getLesson, getGeneratedContent } from "@/lib/db/lessons";
import { countLessonReaders } from "@/lib/db/lesson-views";
import { getClassesByIds, listClassesForSchool } from "@/lib/db/resultpeak";
import { listTopics } from "@/lib/db/topics";
import { classLevel } from "@/lib/class-level";
import { weekLabel } from "@/lib/notes/group";
import { MIN_USABLE_CHARS } from "@/lib/extract/text";
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
    // This page renders the MARKING GUIDE. Class access alone used to be enough,
    // which meant every subject teacher sharing a class could read every other's
    // guide by URL. The author still passes - see assertDocumentSubjectAccess.
    assertDocumentSubjectAccess(session, lesson);
  } catch {
    notFound(); // don't reveal lessons this tutor doesn't teach
  }

  const anythingPublished = lesson.status === "published" || !!lesson.materialPublishedAt;
  const weekly = lesson.kind === "weekly";
  const [content, readers, adminClasses, topics, [cls]] = await Promise.all([
    getGeneratedContent(id),
    anythingPublished
      ? countLessonReaders(id, session.schoolId)
      : Promise.resolve(0),
    // Only admins may move a lesson between classes; tutors get no options.
    session.isAdmin ? listClassesForSchool(session.schoolId) : Promise.resolve([]),
    // A weekly note's section topic pickers. One bounded query, weekly only.
    weekly ? listTopics(session.schoolId) : Promise.resolve([]),
    weekly ? getClassesByIds([lesson.classId]) : Promise.resolve([]),
  ]);

  /**
   * This subject's topics, at the class's level when it is known - the same
   * narrowing generation used, so the pickers offer what the AI chose from.
   */
  const level = cls ? classLevel(cls) : undefined;
  const topicOptions = topics
    .filter((t) => t.subjectId === lesson.subjectId && (!level || t.level === level))
    .map((t) => ({ id: t.id, title: t.title }));

  /**
   * A lesson made from a scan, a slide deck or a photo has no text (owner's
   * decision, 2026-09-11: keep the file, ask for the text). Same floor the
   * generate route enforces, so this screen and that refusal cannot disagree.
   */
  const canGenerate = (lesson.extractedText ?? "").trim().length >= MIN_USABLE_CHARS;

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/tutor" className="text-sm text-muted">
        ← Your lessons
      </Link>
      {(weekly || typeof lesson.week === "number") && (
        <p className="mt-3 text-eyebrow font-semibold uppercase text-brand">
          {weekLabel(lesson.week ?? null)}
          {weekly && " · weekly notes"}
        </p>
      )}
      <h1 className={weekly || typeof lesson.week === "number" ? "mt-1 text-title" : "mt-3 text-title"}>
        {lesson.title}
      </h1>
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

      {!canGenerate && !content && (
        <Callout
          tone="warn"
          className="mt-6"
          title={lesson.fileKey ? "We couldn't read the text in your file" : "This lesson needs more text"}
        >
          {lesson.fileKey
            ? "Your file is saved, and students can open it once you publish the material below. To make a study guide, add the lesson text under Edit lesson."
            : `Add at least ${MIN_USABLE_CHARS} characters under Edit lesson to make a study guide.`}
        </Callout>
      )}

      <EditLessonSection
        lessonId={lesson.id}
        initialTitle={lesson.title}
        initialText={lesson.extractedText}
        initialClassId={lesson.classId}
        initialWeek={lesson.week ?? null}
        weekly={weekly}
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
        {weekly
          ? "Your notes sorted by topic, plus an AI summary and practice questions. Publishes separately from the material above."
          : "AI summary and practice questions, generated from the material. Publishes separately from the material above."}
      </p>
      <ReviewLesson
        lessonId={lesson.id}
        status={lesson.status}
        canGenerate={canGenerate}
        content={
          content
            ? {
                summary: content.summary,
                questions: content.questions,
                markingGuide: content.markingGuide,
                sections: content.sections,
              }
            : null
        }
        weekly={weekly}
        topicOptions={topicOptions}
      />

      <DeleteLesson lessonId={lesson.id} lessonTitle={lesson.title} />
    </main>
  );
}
