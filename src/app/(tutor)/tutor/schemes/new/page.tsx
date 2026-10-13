import { redirect } from "next/navigation";
import Callout from "@/components/ui/Callout";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import AwaitingAllocation from "@/components/tutor/AwaitingAllocation";
import SchemeUploadForm from "@/components/tutor/SchemeUploadForm";
import { getTutorSession } from "@/lib/auth/tutor";
import { authorsNothing, subjectsForClass, unmatchedState } from "@/lib/auth/subject-access";
import { parsePrefill, safeReturnTo } from "@/lib/tutor-shelf";
import {
  getClassesByIds,
  getSubjects,
  getPickerAllocation,
  listClassesForSchool,
} from "@/lib/db/resultpeak";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { storageConfigured } from "@/lib/storage/provider";

/**
 * Upload a scheme of work.
 *
 * Classes, subjects and the tutor's allocation are all read fresh on this
 * request - never cached on the device. A tutor removed from a class in
 * ResultPeak must lose the ability to upload for it on their next page load.
 */
export default async function NewSchemePage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string; subject?: string; returnTo?: string }>;
}) {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [classes, subjects, settings] = await Promise.all([
    session.isAdmin
      ? listClassesForSchool(session.schoolId)
      : getClassesByIds(session.assignedClasses),
    getSubjects(session.schoolId),
    getCurrentTermSession(session.schoolId),
  ]);

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

  return (
    <main className="mx-auto max-w-readable px-5 py-8">
      <PageHeader
        title="Upload a scheme of work"
        lead="What this class will cover this term. Students read it alongside your lessons."
      />

      {/*
        A warning, not a block. Unlike an assignment - whose mark has to land in a
        specific term's continuous assessment, so /api/tutor/assignments refuses
        outright - a scheme carries no mark. Refusing to accept one over a setting
        a school admin has not opened yet would stop a teacher working for a
        reason they cannot fix themselves.
      */}
      {!settings && (
        <Callout tone="warn" className="mt-6">
          Your school admin has not set the current term yet, so this scheme of
          work will show under &ldquo;Earlier&rdquo; instead of under a term. You
          can upload it now and it will still reach your students.
        </Callout>
      )}

      {classes.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No classes yet">
            No classes are assigned to you yet. Ask your school admin to assign your
            classes in ResultPeak, and they&apos;ll appear here.
          </EmptyState>
        </div>
      ) : authorsNothing(session, unmatched, classes.map((c) => c.id)) ? (
        /* Enforcement on, no allocation. After the class check, so a tutor with
           neither is told about the more basic problem first. */
        <div className="mt-6">
          <AwaitingAllocation noun="schemes of work" />
        </div>
      ) : (
        <SchemeUploadForm
          prefill={{ classId: prefill.classId, subjectId: prefill.subjectId }}
          returnTo={returnTo}
          classes={classes.map((c) => ({ id: c.id, name: c.name }))}
          subjects={subjects}
          teachable={teachable}
          unmatched={unmatched}
          filesAvailable={storageConfigured()}
        />
      )}
    </main>
  );
}
