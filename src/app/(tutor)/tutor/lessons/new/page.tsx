import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { getClassesByIds, getSubjects, listClassesForSchool } from "@/lib/db/resultpeak";
import { listTopics } from "@/lib/db/topics";
import { classLevel } from "@/lib/class-level";
import NewLessonForm from "./NewLessonForm";

/**
 * "New lesson" - the entry point of the loop. Loads the pickers server-side
 * (classes the tutor teaches, the school's subjects, and topics) and hands them
 * to a small client form. All authorization is re-checked in POST /api/lessons.
 */
export default async function NewLessonPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [classes, subjects, topics] = await Promise.all([
    session.isAdmin
      ? listClassesForSchool(session.schoolId)
      : getClassesByIds(session.assignedClasses),
    getSubjects(session.schoolId),
    listTopics(session.schoolId),
  ]);

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/tutor" className="text-sm text-muted">
        ← Your lessons
      </Link>
      <h1 className="mt-3 text-title">New lesson</h1>

      {classes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
          No classes are assigned to you yet. Ask your school admin to assign your
          classes in ResultPeak.
        </p>
      ) : (
        <NewLessonForm
          classes={classes.map((c) => ({ id: c.id, name: c.name, level: classLevel(c) }))}
          subjects={subjects}
          topics={topics.map((t) => ({
            id: t.id,
            subjectId: t.subjectId,
            level: t.level,
            title: t.title,
          }))}
        />
      )}
    </main>
  );
}
