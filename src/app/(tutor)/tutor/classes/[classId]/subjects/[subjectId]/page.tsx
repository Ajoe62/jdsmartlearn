import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import PageHeader from "@/components/ui/PageHeader";
import LessonStatusBadge from "@/components/tutor/LessonStatusBadge";
import MoveToWeek from "@/components/tutor/MoveToWeek";
import SchemeRow from "@/components/tutor/SchemeRow";
import { getTutorSession } from "@/lib/auth/tutor";
import { teachesSubjectInClass } from "@/lib/auth/subject-access";
import { termOrder } from "@/lib/academic-calendar";
import { listAssignmentsInClass } from "@/lib/db/assignments";
import { listLessonsInClass } from "@/lib/db/lessons";
import { getClassesByIds, getSubjects, getTutorNames } from "@/lib/db/resultpeak";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { listSchemesForClass } from "@/lib/db/schemes";
import { weekLabel } from "@/lib/notes/group";
import { classHref, groupTutorWeeks, subjectHref, type TermWeeks } from "@/lib/tutor-shelf";
import type { Lesson } from "@/types";

/**
 * One subject in one class: its lessons week by week, its assignments and its
 * schemes of work (owner's request, 2026-10-13). Step three of
 * class -> subject -> week.
 *
 * This term lists Week One to Week Fourteen, filled or not, so a gap shows as a
 * gap with an "Add notes" button that opens the lesson form already set to this
 * class, subject and week. Earlier terms fold away underneath. Topic notes with
 * no week sit under "No week set" with a Move button (owner's decision,
 * 2026-10-13).
 *
 * A teacher sees only their own work here, an admin everyone's. Authorization
 * is checked on the server every request: a class the tutor does not hold, or a
 * subject they do not teach in it, is a 404. Network-only.
 */
export default async function SubjectPage({
  params,
}: {
  params: Promise<{ classId: string; subjectId: string }>;
}) {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");
  const { classId, subjectId } = await params;

  // assignedClasses and the allocation are read fresh from ResultPeak per request.
  if (!session.isAdmin && !session.assignedClasses.includes(classId)) notFound();
  if (!teachesSubjectInClass(session, classId, subjectId)) notFound();

  const [[cls], subjects, settings] = await Promise.all([
    getClassesByIds([classId]),
    getSubjects(session.schoolId),
    getCurrentTermSession(session.schoolId),
  ]);
  const subject = subjects.find((s) => s.id === subjectId);
  if (!cls || cls.schoolId !== session.schoolId || !subject) notFound();

  const own = session.isAdmin ? undefined : session.uid;
  const scope = { schoolId: session.schoolId, classId, subjectId, tutorId: own };

  const [{ lessons, truncated }, assignments, classSchemes, tutorNames] = await Promise.all([
    listLessonsInClass(scope),
    listAssignmentsInClass(scope),
    listSchemesForClass(session.schoolId, classId),
    session.isAdmin ? getTutorNames(session.schoolId) : Promise.resolve(null),
  ]);
  const schemes = classSchemes.filter(
    (s) => s.subjectId === subjectId && (!own || s.tutorId === own)
  );

  const current = settings ? { term: settings.term, session: settings.session } : null;
  const groups = groupTutorWeeks(lessons, current, termOrder);

  const here = subjectHref(classId, subjectId);
  const prefill = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ class: classId, subject: subjectId, ...extra }).toString();
  const newLesson = (extra?: Record<string, string>) => `/tutor/lessons/new?${prefill(extra)}`;
  const author = (l: Lesson) => (tutorNames ? tutorNames.get(l.tutorId) : undefined);

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <Link href={classHref(classId)} className="text-sm text-muted">
        ← {cls.name}
      </Link>
      <PageHeader
        className="mt-3"
        eyebrow={cls.name}
        title={subject.name}
        action={<ButtonLink href={newLesson()}>New lesson</ButtonLink>}
      />

      {truncated && (
        <p className="mt-4 text-sm text-muted">
          Showing the 200 most recent lessons. Older ones are in All lessons.
        </p>
      )}

      {/* ---- Lessons, week by week ---- */}
      <section className="mt-8" aria-labelledby="lessons-heading">
        <h2 id="lessons-heading" className="text-subheading font-semibold">
          Lessons
        </h2>
        {!current && (
          <p className="mt-1 text-sm text-muted">
            Your school admin has not set the current term yet, so new lessons show
            under &ldquo;Term not set&rdquo;.
          </p>
        )}
        <div className="mt-3 space-y-4">
          {groups.map((g) =>
            g.current ? (
              <TermBlock
                key="current"
                group={g}
                addHref={(week) => newLesson({ week: String(week) })}
                author={author}
              />
            ) : (
              <details
                key={`${g.term}\t${g.session}`}
                className="rounded-xl border border-line bg-surface shadow-card"
              >
                <summary className="flex min-h-[44px] cursor-pointer items-center px-4 py-3 font-medium">
                  {termTitle(g)}
                  <span className="ml-2 text-sm font-normal text-muted">
                    {countLabel(g)}
                  </span>
                </summary>
                <div className="border-t border-line p-3">
                  <TermBlock group={g} author={author} bare />
                </div>
              </details>
            )
          )}
        </div>
      </section>

      {/* ---- Assignments ---- */}
      <section className="mt-10" aria-labelledby="assignments-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="assignments-heading" className="text-subheading font-semibold">
            Assignments
          </h2>
          <ButtonLink
            variant="secondary"
            href={`/tutor/assignments/new?${prefill({ returnTo: here })}`}
          >
            New assignment
          </ButtonLink>
        </div>
        {assignments.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No assignments for {subject.name} in {cls.name} yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {assignments.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/tutor/assignments/${encodeURIComponent(a.id)}/submissions`}
                  className="flex min-h-[44px] items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4 shadow-card hover:border-lineStrong"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{a.title}</span>
                    <span className="mt-0.5 block text-sm text-muted">
                      {a.term}, {a.session} · due {formatDate(a.dueDate)}
                      {tutorNames?.get(a.tutorId) && <> · {tutorNames.get(a.tutorId)}</>}
                    </span>
                  </span>
                  <Badge tone={a.isActive ? "success" : "neutral"}>
                    {a.isActive ? "Open" : "Closed"}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- Schemes of work ---- */}
      <section className="mt-10" aria-labelledby="schemes-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="schemes-heading" className="text-subheading font-semibold">
            Schemes of work
          </h2>
          <ButtonLink
            variant="secondary"
            href={`/tutor/schemes/new?${prefill({ returnTo: here })}`}
          >
            Upload scheme
          </ButtonLink>
        </div>
        {schemes.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No scheme of work for {subject.name} in {cls.name} yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {schemes.map((s) => (
              <li key={s.id}>
                <SchemeRow
                  id={s.id}
                  title={s.title}
                  term={s.term}
                  session={s.session}
                  published={!!s.publishedAt}
                  file={s.fileName ? { name: s.fileName, size: s.fileSize ?? 0 } : null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * One term's weeks. The current term is a card with every week listed; an
 * earlier term (`bare`) sits inside its fold and lists only filled weeks.
 */
function TermBlock({
  group,
  addHref,
  author,
  bare,
}: {
  group: TermWeeks<Lesson>;
  addHref?: (week: number) => string;
  author: (l: Lesson) => string | undefined;
  bare?: boolean;
}) {
  const body = (
    <>
      <ol className="divide-y divide-line">
        {group.weeks.map((w) => (
          <li key={w.week} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
            <p className="w-32 shrink-0 pt-0.5 text-sm font-semibold text-brand">
              {weekLabel(w.week)}
            </p>
            <div className="min-w-0 flex-1 space-y-2">
              {w.lessons.map((l) => (
                <LessonLine key={l.id} lesson={l} author={author(l)} />
              ))}
              {addHref && (
                <Link
                  href={addHref(w.week)}
                  className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand"
                >
                  {w.lessons.length === 0 ? "+ Add notes" : "+ Add more"}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>

      {group.noWeek.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <p className="text-sm font-semibold">No week set</p>
          <p className="mt-0.5 text-sm text-muted">
            Move each one to its week once you know where it belongs.
          </p>
          <ul className="mt-3 space-y-4">
            {group.noWeek.map((l) => (
              <li key={l.id} className="space-y-2">
                <LessonLine lesson={l} author={author(l)} />
                <MoveToWeek lessonId={l.id} updatedAt={l.updatedAt} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );

  if (bare) return body;
  return (
    <Card>
      <CardHeader title={termTitle(group)} hint={group.current ? "This term" : undefined} />
      {body}
    </Card>
  );
}

function LessonLine({ lesson, author }: { lesson: Lesson; author?: string }) {
  return (
    <Link
      href={`/tutor/lessons/${encodeURIComponent(lesson.id)}`}
      className="flex min-h-[44px] items-start justify-between gap-3 rounded-lg border border-line px-3 py-2 hover:border-lineStrong hover:bg-canvas"
    >
      <span className="min-w-0">
        <span className="block truncate font-medium">{lesson.title}</span>
        <span className="block text-xs text-muted">
          {lesson.kind === "weekly" ? "Weekly notes" : "Topic notes"}
          {author && <> · {author}</>}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <LessonStatusBadge status={lesson.status} />
        {lesson.materialPublishedAt && lesson.status !== "published" && (
          <span className="text-xs text-muted">Material live</span>
        )}
      </span>
    </Link>
  );
}

/**
 * Undated lessons are "Term not set" while they are the term being filled (no
 * current term chosen yet), and "Earlier" once a term exists - they predate it.
 * Never guessed into a term from a date.
 */
function termTitle(g: { term: string | null; session: string | null; current: boolean }): string {
  if (g.term && g.session) return `${g.term}, ${g.session}`;
  return g.current ? "Term not set" : "Earlier";
}

function countLabel(g: TermWeeks<Lesson>): string {
  const n = g.weeks.reduce((sum, w) => sum + w.lessons.length, 0) + g.noWeek.length;
  return `${n} ${n === 1 ? "lesson" : "lessons"}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
