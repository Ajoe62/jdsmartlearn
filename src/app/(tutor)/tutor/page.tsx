import { redirect } from "next/navigation";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
import { getTutorSession } from "@/lib/auth/tutor";
import { listLessonsForTutor, listLessonsForSchool } from "@/lib/db/lessons";
import { getClassesByIds, getTutorNames, listClassesForSchool } from "@/lib/db/resultpeak";
import { resultPeakUrl } from "@/lib/partner-links";
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

  // Where the marks a tutor enters here end up. "" when ResultPeak is not
  // configured, and then the pill below is not rendered. No school in the path:
  // staff sign in there with their own account and their claims carry schoolId,
  // so a slug would cost a Firestore read to say what the destination knows.
  const resultsUrl = resultPeakUrl("/admin/results");

  const hasClasses = classes.length > 0;
  // Counted from the list already in memory - no extra query, no extra read.
  const waiting = lessons.filter((l) => l.status === "generated").length;

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader
        title={session.isAdmin ? "All lessons in your school" : "Your lessons"}
        lead={
          hasClasses
            ? undefined
            : session.isAdmin
              ? "Classes come from ResultPeak."
              : "Your classes come from ResultPeak."
        }
        action={
          hasClasses && (
            <ButtonLink href="/tutor/lessons/new">New lesson</ButtonLink>
          )
        }
      />

      {hasClasses && (
        <NavPills>
          <NavPill href="/tutor" active>
            Lessons
          </NavPill>
          <NavPill href="/tutor/assignments">Assignments</NavPill>
          <NavPill href="/tutor/sign-ins">Student sign-ins</NavPill>
          {session.isAdmin && <NavPill href="/tutor/settings">Assessment settings</NavPill>}
          {resultsUrl && (
            <NavPill href={resultsUrl} external>
              Results in ResultPeak
            </NavPill>
          )}
        </NavPills>
      )}

      {/* The one thing a teacher might not otherwise notice: study materials
          finished generating and are sitting unpublished. */}
      {waiting > 0 && (
        <p className="mt-6 flex items-center gap-2 text-sm">
          <Badge tone="solid">{waiting}</Badge>
          <span className="text-muted">
            {waiting === 1 ? "study guide is" : "study guides are"} ready for you to review
            and publish.
          </span>
        </p>
      )}

      <div className="mt-6">
        {!hasClasses && (
          <EmptyState title="No classes yet">
            {session.isAdmin
              ? "No classes exist in this school yet. Create them in ResultPeak first, and they'll appear here."
              : "No classes are assigned to you yet. Ask your school admin to assign your classes in ResultPeak."}
          </EmptyState>
        )}

        {hasClasses && lessons.length === 0 && (
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
        )}

        {lessons.length > 0 && (
          <ul className="space-y-3">
            {lessons.map((lesson) => (
              <li key={lesson.id}>
                <CardLink href={`/tutor/lessons/${lesson.id}`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-display font-semibold">{lesson.title}</p>
                      <p className="mt-1 text-sm text-muted">
                        {lesson.className}
                        {tutorNames?.get(lesson.tutorId) && (
                          <> · {tutorNames.get(lesson.tutorId)}</>
                        )}
                        {" · updated "}
                        {formatDate(lesson.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <StatusBadge status={lesson.status} />
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

/**
 * The status ladder: grey, blue tint, solid blue, mint (docs/ilumo-brand.md
 * section 6). "Ready to review" is the loudest because it is the only state
 * waiting on the teacher.
 */
const CHIP: Record<LessonStatus, { label: string; tone: BadgeTone; pulse?: boolean }> = {
  draft: { label: "Draft", tone: "neutral" },
  generating: { label: "Generating…", tone: "info", pulse: true },
  generated: { label: "Ready to review", tone: "solid" },
  published: { label: "Published", tone: "success" },
};

function StatusBadge({ status }: { status: LessonStatus }) {
  const chip = CHIP[status];
  return (
    <Badge tone={chip.tone} pulse={chip.pulse}>
      {chip.label}
    </Badge>
  );
}
