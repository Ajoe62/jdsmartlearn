import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { listLessonsForTutor, listLessonsForSchool } from "@/lib/db/lessons";
import { getClassesByIds, getTutorNames, listClassesForSchool } from "@/lib/db/resultpeak";
import type { LessonStatus } from "@/types";

/**
 * Teacher dashboard: the hub of the loop. Tutors see their own lessons; admins
 * see every lesson in the school with tutor attribution. Classes come from
 * ResultPeak (assignedClasses, or all classes for admins) - never managed here.
 */
export default async function TutorDashboard() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [classes, lessons, tutorNames] = await Promise.all([
    session.isAdmin
      ? listClassesForSchool(session.schoolId)
      : getClassesByIds(session.assignedClasses),
    session.isAdmin
      ? listLessonsForSchool(session.schoolId)
      : listLessonsForTutor(session.schoolId, session.uid),
    session.isAdmin ? getTutorNames(session.schoolId) : Promise.resolve(null),
  ]);

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">
          {session.isAdmin ? "All lessons in your school" : "Your lessons"}
        </h1>
        {classes.length > 0 && (
          <Link
            href="/tutor/lessons/new"
            className="rounded-lg bg-marker px-4 py-2 font-medium text-chalk hover:bg-markerDark"
          >
            New lesson
          </Link>
        )}
      </div>

      {classes.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          <Link href="/tutor/assignments" className="text-sm text-marker underline">
            Assignments
          </Link>
          <Link href="/tutor/sign-ins" className="text-sm text-marker underline">
            Student sign-ins
          </Link>
          {session.isAdmin && (
            <Link href="/tutor/settings" className="text-sm text-marker underline">
              Assessment settings
            </Link>
          )}
        </div>
      )}

      {classes.length === 0 && (
        <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
          {session.isAdmin
            ? "No classes exist in this school yet. Create them in ResultPeak first."
            : "No classes are assigned to you yet. Ask your school admin to assign your classes in ResultPeak."}
        </p>
      )}

      {classes.length > 0 && lessons.length === 0 && (
        <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
          {session.isAdmin
            ? "No lessons in this school yet. Tutors' lessons will appear here as they create them."
            : "Nothing here yet. Upload your first lesson and we'll write the summary and practice questions for you."}
        </p>
      )}

      {lessons.length > 0 && (
        <ul className="mt-6 space-y-3">
          {lessons.map((lesson) => (
            <li key={lesson.id}>
              <Link
                href={`/tutor/lessons/${lesson.id}`}
                className="flex items-center justify-between gap-4 rounded-lg border border-line bg-chalk p-4 hover:border-marker"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{lesson.title}</p>
                  <p className="mt-0.5 text-sm text-slate">
                    {lesson.className}
                    {tutorNames?.get(lesson.tutorId) && (
                      <> · {tutorNames.get(lesson.tutorId)}</>
                    )}
                    {" · updated "}
                    {formatDate(lesson.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusChip status={lesson.status} />
                  {lesson.materialPublishedAt && (
                    <span className="rounded-full bg-paper px-2 py-0.5 text-xs text-slate">
                      Material live
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const CHIP: Record<LessonStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-brassSoft text-brassText" },
  generating: { label: "Generating…", className: "bg-markerSoft text-marker" },
  generated: { label: "Ready to review", className: "bg-brass text-ink" },
  published: { label: "Published", className: "bg-marker text-chalk" },
};

function StatusChip({ status }: { status: LessonStatus }) {
  const chip = CHIP[status];
  return (
    <span
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${chip.className}`}
    >
      {chip.label}
    </span>
  );
}
