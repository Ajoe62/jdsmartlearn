import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import {
  getClassesByIds,
  getSubjects,
  getPickerAllocation,
  listClassesForSchool,
  getSchool,
} from "@/lib/db/resultpeak";
import { authorsNothing, subjectsForClass, unmatchedState } from "@/lib/auth/subject-access";
import { parsePrefill, safeReturnTo } from "@/lib/tutor-shelf";
import { listLessonsForSchool, listLessonsForTutor } from "@/lib/db/lessons";
import { storageConfigured } from "@/lib/storage/provider";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import AwaitingAllocation from "@/components/tutor/AwaitingAllocation";
import NewAssignmentForm from "./NewAssignmentForm";

/**
 * "New assignment". Loads the pickers server-side and hands them to a small
 * client form. All authorization is re-checked in POST /api/tutor/assignments -
 * the form omitting a class it should not offer is a convenience, not a control.
 *
 * `assignedClasses` is read fresh on this request and never cached, so a
 * revocation in ResultPeak applies immediately (CLAUDE.md, Tutor offline).
 */
export default async function NewAssignmentPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string; subject?: string; returnTo?: string }>;
}) {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [classes, subjects, lessons, settings, school] = await Promise.all([
    session.isAdmin
      ? listClassesForSchool(session.schoolId)
      : getClassesByIds(session.assignedClasses),
    getSubjects(session.schoolId),
    // Reuses the dashboard's query. Only published lessons can be linked: an
    // assignment pointing at a draft would be a dead link on a student's phone.
    session.isAdmin
      ? listLessonsForSchool(session.schoolId)
      : listLessonsForTutor(session.schoolId, session.uid),
    /**
     * Read ONCE, here, to prefill. The chosen values are frozen onto the
     * assignment document at creation and never resolved again at read time.
     */
    getCurrentTermSession(session.schoolId),
    getSchool(session.schoolId),
  ]);

  /**
   * Which subjects this tutor may set work in, per class. `{}` means no
   * restriction - an unallocated tutor or an admin.
   *
   * The form omitting a pair it should not offer is a convenience, not a
   * control: POST /api/tutor/assignments re-checks it.
   */
  const { teachable, unmatched } = await getPickerAllocation(
    session.schoolId,
    session,
    classes.map((c) => c.id)
  );

  /**
   * Opened from a subject page: class and subject arrive in the URL. Checked
   * against what this tutor may pick before the form sees them - a prefill is a
   * convenience, and the route re-checks the pair on save anyway.
   */
  const query = await searchParams;
  const prefill = parsePrefill(
    { get: (k) => (query as Record<string, string | undefined>)[k] ?? null },
    {
      classIds: classes.map((c) => c.id),
      subjectsForClass: (id) =>
        unmatchedState(unmatched, id) === "blocked"
          ? []
          : subjectsForClass(teachable, subjects, id).map((s) => s.id),
    }
  );
  const returnTo = safeReturnTo(query.returnTo);

  const linkable = lessons
    .filter((l) => l.status === "published" || l.materialPublishedAt)
    .map((l) => ({
      id: l.id,
      title: l.title,
      classId: l.classId,
      subjectId: l.subjectId,
    }));

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href={returnTo ?? "/tutor"} className="text-sm text-muted">
        {returnTo ? "Back to the subject" : "Back to your classes"}
      </Link>
      <h1 className="mt-3 text-title">New assignment</h1>

      {/*
        No setting means no term and no session to freeze onto the assignment.
        Nothing is guessed: there is no correct answer to derive, and a wrong one
        files a whole class's marks where no result sheet will read them.
      */}
      {!settings ? (
        <div className="mt-6 rounded-lg border border-line bg-surface p-4">
          <p className="font-medium">Your school has not set the current term yet</p>
          <p className="mt-1 text-muted">
            A school admin needs to choose the current term and session before work
            can be set. Until then, marks would not reach any report card.
          </p>
          {session.isAdmin && (
            <Link
              href="/tutor/settings"
              className="mt-4 inline-block font-medium text-brand"
            >
              Open assessment settings
            </Link>
          )}
        </div>
      ) : classes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
          No classes are assigned to you yet. Ask your school admin to assign your
          classes in ResultPeak.
        </p>
      ) : authorsNothing(session, unmatched, classes.map((c) => c.id)) ? (
        /* Enforcement on, no allocation. After the class check, so a tutor with
           neither is told about the more basic problem first. */
        <div className="mt-6">
          <AwaitingAllocation noun="work" />
        </div>
      ) : (
        <NewAssignmentForm
          prefill={{ classId: prefill.classId, subjectId: prefill.subjectId }}
          returnTo={returnTo}
          classes={classes.map((c) => ({ id: c.id, name: c.name }))}
          subjects={subjects}
          teachable={teachable}
          unmatched={unmatched}
          lessons={linkable}
          defaultTerm={settings.term}
          defaultSession={settings.session}
          knownSessions={settings.knownSessions}
          filesAvailable={storageConfigured()}
          assessmentTypes={(school?.assessmentTypes ?? [])
            .filter((item) => item.teacherMarked !== false && item.automated !== true && item.systemMarked !== true)
            .map((item) => ({ value: item.value, label: item.label ?? item.name ?? item.value, maxScore: item.maxScore }))}
        />
      )}
    </main>
  );
}
