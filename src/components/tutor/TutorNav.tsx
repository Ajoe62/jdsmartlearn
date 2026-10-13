import { NavPill, NavPills } from "@/components/ui/PageHeader";

/**
 * The tutor's top menu on the class list and the all-lessons list. "Classes"
 * leads since 2026-10-13: a teacher starts from a class, then a subject, then a
 * week, so lessons from different classes never sit in one list by accident.
 */
export default function TutorNav({
  active,
  isAdmin,
  resultsUrl,
}: {
  active: "classes" | "lessons";
  isAdmin: boolean;
  resultsUrl: string;
}) {
  return (
    <NavPills>
      <NavPill href="/tutor" active={active === "classes"}>
        Classes
      </NavPill>
      <NavPill href="/tutor/lessons" active={active === "lessons"}>
        All lessons
      </NavPill>
      <NavPill href="/tutor/assignments">Assignments</NavPill>
      <NavPill href="/tutor/schemes">Schemes of work</NavPill>
      <NavPill href="/tutor/announcements">Announcements</NavPill>
      <NavPill href="/tutor/sign-ins">Student sign-ins</NavPill>
      {isAdmin && <NavPill href="/tutor/settings">Assessment settings</NavPill>}
      {resultsUrl && (
        <NavPill href={resultsUrl} external>
          Results in ResultPeak
        </NavPill>
      )}
    </NavPills>
  );
}
