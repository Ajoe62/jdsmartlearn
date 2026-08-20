import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import {
  getClassesByIds,
  getSubjects,
  getTeachableMap,
  listClassesForSchool,
} from "@/lib/db/resultpeak";
import { listLessonsForSchool, listLessonsForTutor } from "@/lib/db/lessons";
import { storageConfigured } from "@/lib/storage/provider";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import NewAssignmentForm from "./NewAssignmentForm";

/**
 * "New assignment". Loads the pickers server-side and hands them to a small
 * client form. All authorization is re-checked in POST /api/tutor/assignments -
 * the form omitting a class it should not offer is a convenience, not a control.
 *
 * `assignedClasses` is read fresh on this request and never cached, so a
 * revocation in ResultPeak applies immediately (CLAUDE.md, Tutor offline).
 */
export default async function NewAssignmentPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [classes, subjects, lessons, settings] = await Promise.all([
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
  ]);

  /**
   * Which subjects this tutor may set work in, per class. `{}` means no
   * restriction - an unallocated tutor or an admin.
   *
   * The form omitting a pair it should not offer is a convenience, not a
   * control: POST /api/tutor/assignments re-checks it.
   */
  const teachable = await getTeachableMap(
    session.schoolId,
    session,
    classes.map((c) => c.id)
  );

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
      <Link href="/tutor" className="text-sm text-muted">
        Back to your lessons
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
      ) : (
        <NewAssignmentForm
          classes={classes.map((c) => ({ id: c.id, name: c.name }))}
          subjects={subjects}
          teachable={teachable}
          lessons={linkable}
          defaultTerm={settings.term}
          defaultSession={settings.session}
          knownSessions={settings.knownSessions}
          filesAvailable={storageConfigured()}
        />
      )}
    </main>
  );
}
