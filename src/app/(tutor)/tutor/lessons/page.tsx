import { redirect } from "next/navigation";
import { ButtonLink } from "@/components/ui/Button";
import { CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import LessonStatusBadge from "@/components/tutor/LessonStatusBadge";
import TutorNav from "@/components/tutor/TutorNav";
import { getTutorSession } from "@/lib/auth/tutor";
import { getSchoolBrand } from "@/lib/branding/school";
import { listLessonsForTutor, listLessonsForSchool } from "@/lib/db/lessons";
import { getTutorNames, getSubjects } from "@/lib/db/resultpeak";
import { resultPeakUrl } from "@/lib/partner-links";
import { weekLabel } from "@/lib/notes/group";

/**
 * Every lesson in one list, newest first - the dashboard as it was before the
 * class -> subject -> week view (2026-10-13). Kept for a teacher who wants to
 * find "the one I edited yesterday" without knowing where it lives.
 *
 * Network-only, like every tutor page but /tutor and /tutor/lessons/new.
 */
export default async function AllLessonsPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [lessons, tutorNames, subjects, brand] = await Promise.all([
    session.isAdmin
      ? listLessonsForSchool(session.schoolId)
      : listLessonsForTutor(session.schoolId, session.uid),
    session.isAdmin ? getTutorNames(session.schoolId) : Promise.resolve(null),
    getSubjects(session.schoolId),
    getSchoolBrand(session.schoolId),
  ]);
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader
        title={session.isAdmin ? "All lessons in your school" : "All your lessons"}
        lead="Newest first. To see lessons week by week, open a class."
        action={<ButtonLink href="/tutor/lessons/new">New lesson</ButtonLink>}
      />
      <TutorNav
        active="lessons"
        isAdmin={session.isAdmin}
        resultsUrl={resultPeakUrl("/admin/results", brand?.resultsUrl)}
      />

      <div className="mt-6">
        {lessons.length === 0 ? (
          <EmptyState
            title={session.isAdmin ? "No lessons yet" : "Start your first lesson"}
            action={
              !session.isAdmin && <ButtonLink href="/tutor/lessons/new">New lesson</ButtonLink>
            }
          >
            {session.isAdmin
              ? "Lessons will appear here as your teachers create them."
              : "Upload a lesson and we'll write the summary and practice questions for you. You review everything before your class sees it."}
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {lessons.map((lesson) => (
              <li key={lesson.id}>
                <CardLink href={`/tutor/lessons/${lesson.id}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-display font-semibold">{lesson.title}</p>
                      <p className="mt-1 text-sm text-muted">
                        {typeof lesson.week === "number" && (
                          <span className="font-medium text-brand">{weekLabel(lesson.week)} · </span>
                        )}
                        {lesson.className}
                        {subjectName.get(lesson.subjectId) && (
                          <> · {subjectName.get(lesson.subjectId)}</>
                        )}
                        {tutorNames?.get(lesson.tutorId) && (
                          <> · {tutorNames.get(lesson.tutorId)}</>
                        )}
                        {" · updated "}
                        {formatDate(lesson.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <LessonStatusBadge status={lesson.status} />
                      {lesson.materialPublishedAt && (
                        <span className="text-xs text-muted">Material live</span>
                      )}
                    </div>
                  </div>
                </CardLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
