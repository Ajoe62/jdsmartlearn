import { redirect } from "next/navigation";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import AnnouncementComposer from "@/components/tutor/AnnouncementComposer";
import { getTutorSession } from "@/lib/auth/tutor";
import { getClassesByIds, listClassesForSchool } from "@/lib/db/resultpeak";

/**
 * Write an announcement.
 *
 * Classes come from ResultPeak, read fresh on this request - admins get every
 * class in the school, tutors get their own `assignedClasses`. Never cached: a
 * tutor removed from a class in ResultPeak must lose the ability to address it
 * on their next page load, not on their next session.
 */
export default async function NewAnnouncementPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const classes = session.isAdmin
    ? await listClassesForSchool(session.schoolId)
    : await getClassesByIds(session.assignedClasses);

  // A tutor with no classes has nobody to address. An admin always does, because
  // "the whole school" needs no class at all.
  const canSend = session.isAdmin || classes.length > 0;

  return (
    <main className="mx-auto max-w-readable px-5 py-8">
      <PageHeader
        title="New announcement"
        lead={
          session.isAdmin
            ? "Send it to the whole school or to one class."
            : "Send it to a class you teach."
        }
      />

      {canSend ? (
        <AnnouncementComposer
          classes={classes.map((c) => ({ id: c.id, name: c.name }))}
          isAdmin={session.isAdmin}
        />
      ) : (
        <div className="mt-6">
          <EmptyState title="No classes yet">
            No classes are assigned to you yet. Ask your school admin to assign your
            classes in ResultPeak, and they&apos;ll appear here.
          </EmptyState>
        </div>
      )}
    </main>
  );
}
