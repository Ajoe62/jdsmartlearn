import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { buildAssignmentList } from "@/lib/db/submissions";
import AssignmentsView from "@/components/student/AssignmentsView";
import { ASSIGNMENT_TABS } from "@/types/student-dashboard";
import type { AssignmentTab } from "@/types/student-dashboard";

/**
 * The student's assignments. Read only, like every student route.
 *
 * Server-rendered on the first visit so a cheap phone has content before any JS
 * runs; afterwards the service worker serves the shell and AssignmentsView
 * renders the same data from IndexedDB. One component for both paths.
 *
 * Costs one cached class query plus one query for this student's own submissions.
 * Never fans out per assignment.
 */
export default async function StudentAssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const params = await searchParams;
  const requested = params.tab as AssignmentTab | undefined;
  const tab: AssignmentTab =
    requested && ASSIGNMENT_TABS.includes(requested) ? requested : "pending";

  const items = await buildAssignmentList(
    session.schoolId,
    session.classId,
    session.studentId
  );

  return <AssignmentsView initial={items} tab={tab} />;
}
