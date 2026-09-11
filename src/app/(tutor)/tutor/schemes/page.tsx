import { redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import Callout from "@/components/ui/Callout";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
import AwaitingAllocation from "@/components/tutor/AwaitingAllocation";
import SchemeRow from "@/components/tutor/SchemeRow";
import { getTutorSession } from "@/lib/auth/tutor";
import { listSchemesForSchoolClasses } from "@/lib/db/schemes";
import {
  getClassesByIds,
  getSubjects,
  getTeachableMap,
  listClassesForSchool,
} from "@/lib/db/resultpeak";
import { isAwaitingAllocation, subjectsForClass } from "@/lib/auth/subject-access";
import type { Scheme } from "@/types/schemes";

/**
 * Schemes of work, grouped by class.
 *
 * THE POINT OF THIS SCREEN IS THE GAPS, not the list. A tutor teaches four to
 * eight subjects; what a head teacher chases is which of them still has no
 * scheme uploaded. So every (class, subject) pair this tutor teaches gets a row,
 * whether or not anything has been uploaded for it, and the missing ones are
 * called out rather than simply absent.
 *
 * EVERY scheme for a pair is listed, newest first. This used to keep one per
 * pair in a Map built from a newest-first list, which kept the OLDEST - so a
 * tutor re-uploading a scheme saw their old one and concluded the upload had
 * failed.
 */
export default async function SchemesPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [classes, subjects] = await Promise.all([
    session.isAdmin
      ? listClassesForSchool(session.schoolId)
      : getClassesByIds(session.assignedClasses),
    getSubjects(session.schoolId),
  ]);

  const teachable = await getTeachableMap(
    session.schoolId,
    session,
    classes.map((c) => c.id)
  );

  // Newest first, from the query.
  const schemes = await listSchemesForSchoolClasses(
    session.schoolId,
    classes.map((c) => c.id)
  );

  const byPair = new Map<string, Scheme[]>();
  for (const scheme of schemes) {
    const key = `${scheme.classId}\t${scheme.subjectId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), scheme]);
  }

  const missing = classes.reduce((total, c) => {
    const offered = subjectsForClass(teachable, subjects, c.id);
    return total + offered.filter((s) => !byPair.has(`${c.id}\t${s.id}`)).length;
  }, 0);

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader
        title="Schemes of work"
        lead="What each class will cover this term. Students can read these alongside your lessons."
        action={<ButtonLink href="/tutor/schemes/new">Upload a scheme</ButtonLink>}
      />

      <NavPills>
        <NavPill href="/tutor">Lessons</NavPill>
        <NavPill href="/tutor/assignments">Assignments</NavPill>
        <NavPill href="/tutor/schemes" active>
          Schemes of work
        </NavPill>
        <NavPill href="/tutor/announcements">Announcements</NavPill>
        <NavPill href="/tutor/sign-ins">Student sign-ins</NavPill>
      </NavPills>

      {classes.length === 0 ? (
        <div className="mt-8">
          <EmptyState title="No classes yet">
            {session.isAdmin
              ? "No classes exist in this school yet. Create them in ResultPeak first, and they'll appear here."
              : "No classes are assigned to you yet. Ask your school admin to assign your classes in ResultPeak."}
          </EmptyState>
        </div>
      ) : isAwaitingAllocation(session) ? (
        /*
          Enforcement on, no allocation. Without this the `{}` teachable map
          would offer every school subject for every class below, and the
          "no scheme of work yet" count would be a tally of work this tutor is
          not allowed to do.
        */
        <div className="mt-8">
          <AwaitingAllocation noun="schemes of work" />
        </div>
      ) : (
        <>
          {missing > 0 && (
            <Callout tone="warn" className="mt-6">
              {missing} subject{missing === 1 ? " has" : "s have"} no scheme of work yet.
              Students see nothing under &ldquo;What you will cover&rdquo; until you
              upload one.
            </Callout>
          )}

          <div className="mt-6 space-y-5">
            {classes.map((klass) => {
              const offered = subjectsForClass(teachable, subjects, klass.id);
              if (offered.length === 0) return null;
              return (
                <Card key={klass.id}>
                  <CardHeader
                    title={klass.name}
                    hint={`${offered.length} subject${offered.length === 1 ? "" : "s"}`}
                  />
                  <ul className="divide-y divide-line">
                    {offered.map((subject) => {
                      const list = byPair.get(`${klass.id}\t${subject.id}`) ?? [];
                      return (
                        <li key={subject.id} className="px-4 py-3">
                          {list.length === 0 ? (
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate font-medium">{subject.name}</p>
                                <p className="mt-0.5 text-sm text-muted">
                                  No scheme of work yet
                                </p>
                              </div>
                              <Badge tone="warn">Missing</Badge>
                            </div>
                          ) : (
                            <>
                              <p className="truncate font-medium">{subject.name}</p>
                              <ul className="mt-2 space-y-4">
                                {list.map((scheme) => (
                                  <li key={scheme.id}>
                                    <SchemeRow
                                      id={scheme.id}
                                      title={scheme.title}
                                      term={scheme.term}
                                      session={scheme.session}
                                      published={!!scheme.publishedAt}
                                      file={
                                        scheme.fileName
                                          ? { name: scheme.fileName, size: scheme.fileSize ?? 0 }
                                          : null
                                      }
                                    />
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
