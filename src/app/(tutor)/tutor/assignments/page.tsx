import Link from "next/link";
import { redirect } from "next/navigation";
import { ButtonLink } from "@/components/ui/Button";
import { getTutorSession } from "@/lib/auth/tutor";
import { listAssignmentsForTutor } from "@/lib/db/assignments";
import { getSchoolSkips } from "@/lib/db/skips";
import SkipNotices from "@/components/tutor/SkipNotices";
import { ASSIGNMENT_TYPE_LABELS } from "@/types/student-dashboard";

/**
 * The tutor's assignments, newest due date first.
 *
 * Where the new assignment form lands, and the way in to each submission list.
 * One equality-filtered query, sorted in memory, marking guides never rendered.
 *
 * THE SKIP SURFACE BELONGS HERE, not only on the submissions page. Every skip
 * condition is school-wide: marking switched off, or no assessment type mapped,
 * affects every assignment this tutor has ever set. Showing it only on a
 * per-assignment page meant a tutor saw it only after opening one, and a tutor
 * with no submissions yet never saw it at all. `mapping_unset` is the live state
 * of the only configured school, so that was not a hypothetical gap.
 */
export default async function TutorAssignmentsPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [assignments, skips] = await Promise.all([
    listAssignmentsForTutor(session.schoolId, session.uid),
    getSchoolSkips(session.schoolId),
  ]);
  const now = Date.now();

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-title">Your assignments</h1>
        <ButtonLink href="/tutor/assignments/new">New assignment</ButtonLink>
      </div>

      <Link href="/tutor" className="mt-3 block text-sm text-muted">
        Back to your lessons
      </Link>

      <SkipNotices reasons={skips} />

      {assignments.length === 0 ? (
        <div className="mt-8 rounded-lg border border-line bg-surface p-6">
          <p className="font-medium">No assignments yet</p>
          <p className="mt-1 text-muted">
            Set work for a class and the AI will mark it against your marking guide.
            You review every mark before students see it.
          </p>
          <Link
            href="/tutor/assignments/new"
            className="mt-4 inline-block font-medium text-brand"
          >
            Set your first assignment
          </Link>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {assignments.map((a) => (
            <li key={a.id} className="rounded-lg border border-line bg-surface p-4">
              <Link href={`/tutor/assignments/${a.id}/submissions`} className="block">
                <p className="font-medium">{a.title}</p>
                <p className="mt-1 text-sm text-muted">
                  {a.className}. {a.subjectName}. {ASSIGNMENT_TYPE_LABELS[a.type]}.{" "}
                  {a.maxMarks} marks.
                </p>
                <p className="mt-1 text-sm">
                  {a.isActive ? (
                    <span className="text-muted">
                      Due {new Date(a.dueDate).toDateString()}
                      {a.dueDate < now ? ". Closed" : ""}
                    </span>
                  ) : (
                    <span className="text-muted">Not released to the class</span>
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
