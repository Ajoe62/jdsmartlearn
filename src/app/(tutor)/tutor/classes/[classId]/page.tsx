import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { CardLink } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import AwaitingAllocation from "@/components/tutor/AwaitingAllocation";
import { getTutorSession } from "@/lib/auth/tutor";
import { authorsNothing, subjectsForClass, unmatchedState } from "@/lib/auth/subject-access";
import { listAssignmentsInClass } from "@/lib/db/assignments";
import { getClassSubjects, isDerivedFromContentOnly } from "@/lib/db/class-subjects";
import { listLessonsInClass } from "@/lib/db/lessons";
import {
  getClassesByIds,
  getPickerAllocation,
  getSubjects,
  getTutorNames,
} from "@/lib/db/resultpeak";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { listSchemesForClass } from "@/lib/db/schemes";
import { subjectHref, subjectProgress } from "@/lib/tutor-shelf";

/**
 * One class: the subjects in it, each leading to its weeks (owner's request,
 * 2026-10-13). Step two of class -> subject -> week.
 *
 * WHICH SUBJECTS.
 *   A teacher with an allocation sees the subjects ResultPeak assigned them IN
 *   THIS CLASS - so Maths in JSS 2 and Maths in JSS 3 are two separate doors.
 *   An admin, or a teacher ResultPeak has not allocated yet, sees the class's
 *   derived subject list (db/class-subjects - a named workaround until
 *   ResultPeak owns classes/{id}.subjectIds[]), plus anything with content.
 *
 * WHOSE WORK. A teacher sees only their own lessons, assignments and schemes,
 * even when another teacher shares the subject; an admin sees everyone's
 * (owner's decision, 2026-10-13).
 *
 * Authorization is checked here, on the server, every request - a class the
 * tutor does not hold is a 404, not a hidden link. Network-only: the service
 * worker caches /tutor and /tutor/lessons/new and nothing else.
 */
export default async function ClassPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");
  const { classId } = await params;

  // assignedClasses is read fresh from ResultPeak on every request.
  if (!session.isAdmin && !session.assignedClasses.includes(classId)) notFound();
  const [cls] = await getClassesByIds([classId]);
  if (!cls || cls.schoolId !== session.schoolId) notFound();

  const settings = await getCurrentTermSession(session.schoolId);
  const current = settings ? { term: settings.term, session: settings.session } : undefined;
  const own = session.isAdmin ? undefined : session.uid;

  const [{ lessons, truncated }, assignments, allSchemes, schoolSubjects, picker, tutorNames] =
    await Promise.all([
      // Counts are for THIS term when one is set, so a class with years of
      // history still fits inside one bounded query.
      listLessonsInClass({ schoolId: session.schoolId, classId, tutorId: own, term: current }),
      listAssignmentsInClass({ schoolId: session.schoolId, classId, tutorId: own }),
      listSchemesForClass(session.schoolId, classId),
      getSubjects(session.schoolId),
      getPickerAllocation(session.schoolId, session, [classId]),
      session.isAdmin ? getTutorNames(session.schoolId) : Promise.resolve(null),
    ]);
  const schemes = own ? allSchemes.filter((s) => s.tutorId === own) : allSchemes;

  // Enforcement on and nothing allocated here: name the fix, not an empty list.
  if (authorsNothing(session, picker.unmatched, [classId])) {
    return (
      <Shell title={cls.name}>
        <div className="mt-6">
          <AwaitingAllocation noun="lessons" />
        </div>
      </Shell>
    );
  }

  /**
   * A teacher with a usable allocation in this class gets exactly that list.
   * Everyone else - an admin, an unallocated teacher, or a class ResultPeak left
   * with no subject for this teacher while enforcement is off - would otherwise
   * get every subject in the school, so they get the class's derived list
   * instead, with an "Another subject" door for anything missing.
   */
  const allocated =
    !session.isAdmin &&
    Object.keys(picker.teachable).length > 0 &&
    unmatchedState(picker.unmatched, classId) === null;

  const observed = new Set([
    ...lessons.map((l) => l.subjectId),
    ...assignments.map((a) => a.subjectId),
    ...schemes.map((s) => s.subjectId),
  ]);
  const derived = allocated ? null : await getClassSubjects(session.schoolId, classId, observed);
  const subjects = allocated
    ? subjectsForClass(picker.teachable, schoolSubjects, classId).map((s) => ({
        id: s.id,
        name: s.name,
      }))
    : derived!;

  const termLabel = current ? `${current.term}, ${current.session}` : null;

  return (
    <Shell title={cls.name}>
      {truncated && (
        <Callout tone="neutral" className="mt-6">
          This class has a lot of lessons, so some counts below may be short. Each
          subject page shows its lessons in full.
        </Callout>
      )}

      {!allocated && derived && isDerivedFromContentOnly(derived) && (
        <Callout tone="neutral" className="mt-6">
          Some subjects may be missing. Subjects appear here once a teacher is
          assigned to them in ResultPeak, or once they have a lesson.
        </Callout>
      )}

      {subjects.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No subjects yet"
            action={
              <ButtonLink href={`/tutor/lessons/new?class=${encodeURIComponent(classId)}`}>
                New lesson
              </ButtonLink>
            }
          >
            {session.isAdmin
              ? "No teacher is assigned to a subject in this class yet. Assign teachers in ResultPeak, and their subjects will appear here."
              : "Start a lesson for this class and its subject will appear here."}
          </EmptyState>
        </div>
      ) : (
        <>
          <p className="mt-6 text-sm text-muted">
            {termLabel ? `Lesson counts are for ${termLabel}.` : "Lesson counts are for every term."}
          </p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {subjects.map((s) => {
              const mine = lessons.filter((l) => l.subjectId === s.id);
              const p = subjectProgress(mine);
              const nAssign = assignments.filter((a) => a.subjectId === s.id).length;
              const nSchemes = schemes.filter((x) => x.subjectId === s.id).length;
              const authors = tutorNames
                ? [...new Set(mine.map((l) => tutorNames.get(l.tutorId)).filter(Boolean))]
                : [];
              return (
                <li key={s.id}>
                  <CardLink href={subjectHref(classId, s.id)} className="h-full">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 truncate font-display font-semibold">{s.name}</p>
                      {p.toReview > 0 && <Badge tone="solid">{p.toReview} to review</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {p.lessons === 0
                        ? "No lessons yet"
                        : `${p.weeksCovered} ${p.weeksCovered === 1 ? "week" : "weeks"} with notes · ${p.lessons} ${p.lessons === 1 ? "lesson" : "lessons"}`}
                    </p>
                    {(nAssign > 0 || nSchemes > 0) && (
                      <p className="mt-0.5 text-sm text-muted">
                        {[
                          nAssign > 0 && `${nAssign} ${nAssign === 1 ? "assignment" : "assignments"}`,
                          nSchemes > 0 && `${nSchemes} ${nSchemes === 1 ? "scheme" : "schemes"} of work`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                    {authors.length > 0 && (
                      <p className="mt-0.5 truncate text-sm text-muted">By {authors.join(", ")}</p>
                    )}
                  </CardLink>
                </li>
              );
            })}
          </ul>
          {!allocated && !session.isAdmin && (
            <p className="mt-4 text-sm">
              <Link
                href={`/tutor/lessons/new?class=${encodeURIComponent(classId)}`}
                className="font-medium text-brand"
              >
                Teaching another subject here? Start a lesson
              </Link>
            </p>
          )}
        </>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <Link href="/tutor" className="text-sm text-muted">
        ← All classes
      </Link>
      <PageHeader className="mt-3" title={title} lead="Choose a subject." />
      {children}
    </main>
  );
}
