import { redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import { getTutorSession } from "@/lib/auth/tutor";
import { getSchoolBrand } from "@/lib/branding/school";
import { getNoticesForTutor } from "@/lib/db/announcements";
import { getReadState } from "@/lib/db/read-state";
import { toNoticeItem, visibleToTutor } from "@/lib/announcements/notices";
import TutorNotices from "@/components/tutor/TutorNotices";
import TutorNav from "@/components/tutor/TutorNav";
import { listLessonsForTutor } from "@/lib/db/lessons";
import { getClassesByIds, listClassesForSchool } from "@/lib/db/resultpeak";
import { resultPeakUrl } from "@/lib/partner-links";
import { classLevel } from "@/lib/class-level";
import { classHref, groupByStage, STAGE_LABELS } from "@/lib/tutor-shelf";
import type { Lesson } from "@/types";

/**
 * Teacher dashboard: the classes they teach, each leading to its subjects and
 * then week by week (owner's request, 2026-10-13). Before that this was one list
 * of every lesson, and subjects from different classes sat side by side. That
 * list lives on at /tutor/lessons.
 *
 * Admins get every class in the school, grouped Nursery -> Primary -> Junior ->
 * Senior. Classes come from ResultPeak (assignedClasses, or all classes for
 * admins) - never managed here.
 *
 * Cached on the phone by the service worker (network first), so it carries
 * class names and counts only - no marking guide, no student data.
 */
export default async function TutorDashboard() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [classes, lessons, noticeCandidates, readState, brand] = await Promise.all([
    session.isAdmin
      ? listClassesForSchool(session.schoolId)
      : getClassesByIds(session.assignedClasses),
    /**
     * A teacher's own lessons, for the per-class counts: one query they already
     * paid for on the old dashboard. An admin's class list shows no counts -
     * every lesson in a school does not fit in one bounded query, and a count
     * that silently stops at 200 is worse than none. Each class page counts its
     * own.
     */
    session.isAdmin
      ? Promise.resolve([] as Lesson[])
      : listLessonsForTutor(session.schoolId, session.uid),
    getNoticesForTutor(session.schoolId, session.uid),
    getReadState(session.schoolId, session.uid),
    /**
     * Read for one field: the school's own ResultPeak origin, if it has a
     * domain of its own. Cached per school and already fetched by the layout
     * on this request, so it costs no extra Firestore read in the common case.
     */
    getSchoolBrand(session.schoolId),
  ]);

  const notices = visibleToTutor(
    noticeCandidates,
    session.uid,
    session.assignedClasses,
    Date.now()
  ).map(toNoticeItem);

  // Where the marks a tutor enters here end up. "" when ResultPeak is not
  // configured, and then the pill is not rendered. A school with its own
  // results domain sends its staff there instead of to the shared deployment.
  const resultsUrl = resultPeakUrl("/admin/results", brand?.resultsUrl);

  const hasClasses = classes.length > 0;

  // Counted from the list already in memory - no extra query, no extra read.
  const perClass = new Map<string, { lessons: number; toReview: number }>();
  for (const l of lessons) {
    const c = perClass.get(l.classId) ?? { lessons: 0, toReview: 0 };
    c.lessons++;
    if (l.status === "generated") c.toReview++;
    perClass.set(l.classId, c);
  }
  const waiting = lessons.filter((l) => l.status === "generated").length;

  const stages = groupByStage(
    classes.map((c) => ({ id: c.id, name: c.name, level: classLevel(c) }))
  );

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader
        title={session.isAdmin ? "Classes in your school" : "Your classes"}
        lead={
          hasClasses
            ? "Choose a class to see its subjects and lessons week by week."
            : session.isAdmin
              ? "Classes come from ResultPeak."
              : "Your classes come from ResultPeak."
        }
        action={
          hasClasses && <ButtonLink href="/tutor/lessons/new">New lesson</ButtonLink>
        }
      />

      {hasClasses && (
        <TutorNav active="classes" isAdmin={session.isAdmin} resultsUrl={resultsUrl} />
      )}

      {/* Above the work queue: a notice from the school office is the one thing
          on this page the teacher did not come looking for. */}
      <TutorNotices initial={notices} initialReadState={readState} />

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

        {stages.map(({ stage, classes: inStage }) => (
          <section key={stage} className="mt-6 first:mt-0">
            {/* A stage heading only helps when there is more than one stage. */}
            {stages.length > 1 && (
              <h2 className="mb-3 text-eyebrow font-semibold uppercase text-muted">
                {STAGE_LABELS[stage]}
              </h2>
            )}
            <ul className="grid gap-3 sm:grid-cols-2">
              {inStage.map((c) => {
                const count = perClass.get(c.id);
                return (
                  <li key={c.id}>
                    <CardLink href={classHref(c.id)} className="h-full">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-display font-semibold">{c.name}</p>
                          {!session.isAdmin && (
                            <p className="mt-1 text-sm text-muted">
                              {count
                                ? `${count.lessons} ${count.lessons === 1 ? "lesson" : "lessons"}`
                                : "No lessons yet"}
                            </p>
                          )}
                        </div>
                        {count && count.toReview > 0 && (
                          <Badge tone="solid">{count.toReview} to review</Badge>
                        )}
                      </div>
                    </CardLink>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
