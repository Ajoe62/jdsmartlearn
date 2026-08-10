import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { listAssignmentsForTutor } from "@/lib/db/assignments";
import { ASSIGNMENT_TYPE_LABELS } from "@/types/student-dashboard";

/**
 * The tutor's assignments, newest due date first.
 *
 * Where the new assignment form lands, and the way in to each submission list.
 * One equality-filtered query, sorted in memory, marking guides never rendered.
 */
export default async function TutorAssignmentsPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const assignments = await listAssignmentsForTutor(session.schoolId, session.uid);
  const now = Date.now();

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Your assignments</h1>
        <Link
          href="/tutor/assignments/new"
          className="rounded-lg bg-marker px-4 py-2 font-medium text-chalk hover:bg-markerDark"
        >
          New assignment
        </Link>
      </div>

      <Link href="/tutor" className="mt-3 block text-sm text-slate">
        Back to your lessons
      </Link>

      {assignments.length === 0 ? (
        <div className="mt-8 rounded-lg border border-line bg-chalk p-6">
          <p className="font-medium">No assignments yet</p>
          <p className="mt-1 text-slate">
            Set work for a class and the AI will mark it against your marking guide.
            You review every mark before students see it.
          </p>
          <Link
            href="/tutor/assignments/new"
            className="mt-4 inline-block font-medium text-marker"
          >
            Set your first assignment
          </Link>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {assignments.map((a) => (
            <li key={a.id} className="rounded-lg border border-line bg-chalk p-4">
              <Link href={`/tutor/assignments/${a.id}/submissions`} className="block">
                <p className="font-medium">{a.title}</p>
                <p className="mt-1 text-sm text-slate">
                  {a.className}. {a.subjectName}. {ASSIGNMENT_TYPE_LABELS[a.type]}.{" "}
                  {a.maxMarks} marks.
                </p>
                <p className="mt-1 text-sm">
                  {a.isActive ? (
                    <span className="text-slate">
                      Due {new Date(a.dueDate).toDateString()}
                      {a.dueDate < now ? ". Closed" : ""}
                    </span>
                  ) : (
                    <span className="text-slate">Not released to the class</span>
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
