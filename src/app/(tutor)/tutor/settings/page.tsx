import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { getSchool } from "@/lib/db/resultpeak";
import { getCurrentTermSession, observedSessions } from "@/lib/db/school-settings";
import SchoolSettingsForm from "./SchoolSettingsForm";
import { getSchoolBrand } from "@/lib/branding/school";
import { resultPeakUrl } from "@/lib/partner-links";

/**
 * Assessment settings. SCHOOL ADMIN ONLY, and rarely opened.
 *
 * This is the cold path that grounds the whole term and session design. It runs
 * two ResultPeak reads to find which academic sessions the school's own exams
 * and results actually contain, so the admin picks a string that will join
 * rather than one that is calendrically correct. ResultPeak's own session
 * default is wrong for two thirds of the year, so those two are often different.
 */
export default async function SchoolSettingsPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  if (!session.isAdmin) {
    return (
      <main className="mx-auto max-w-readable px-5 py-10">
        <Link href="/tutor" className="text-sm text-muted">
          Back to your lessons
        </Link>
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
          Only a school admin can change assessment settings. Ask your admin to set
          the current term and session.
        </p>
      </main>
    );
  }

  const [current, sessions, school, brand] = await Promise.all([
    getCurrentTermSession(session.schoolId),
    observedSessions(session.schoolId),
    getSchool(session.schoolId),
    getSchoolBrand(session.schoolId),
  ]);

  // ResultPeak's own list, by its stable `value`. Never a default of ours.
  const assessmentTypes =
    (school as { assessmentTypes?: { value: string; label: string; maxScore: number }[] } | null)
      ?.assessmentTypes ?? [];

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/tutor" className="text-sm text-muted">
        Back to your lessons
      </Link>
      <h1 className="mt-3 text-title">Assessment settings</h1>
      <p className="mt-2 text-muted">
        These decide which term and session a piece of work counts towards, and
        which column its score lands in on the result sheet.
      </p>

      <SchoolSettingsForm
        current={
          current
            ? {
                term: current.term,
                session: current.session,
                sessionIsOverride: current.sessionIsOverride,
                lmsAssessmentType: current.lmsAssessmentType,
              }
            : null
        }
        sessions={sessions}
        assessmentTypes={assessmentTypes}
      />

      {brand && (
        <BrandingNotice schoolName={brand.name} resultsUrl={brand.resultsUrl} />
      )}
    </main>
  );
}

/**
 * Where a school's crest, colour and short name are edited: ResultPeak.
 *
 * THERE IS NO BRANDING FORM HERE ANY MORE, and that is the point of this
 * notice rather than an apology for it. Branding was owned by both products for
 * two days in August 2026, which meant two upload forms and two validators for
 * one school's crest. ResultPeak won the decision on 2026-08-29 because its
 * crest is a data URI on a document both products already read, and this repo's
 * editor was removed rather than deprecated: a form left running is a form
 * somebody uses, and then two records disagree about what a school looks like.
 *
 * A link when the cross-link is configured, plain text naming the screen when it
 * is not. A dead link is worse than a sentence, because an admin clicks it.
 */
function BrandingNotice({
  schoolName,
  resultsUrl,
}: {
  schoolName: string;
  /** The school's own ResultPeak origin, or null for the shared deployment. */
  resultsUrl: string | null;
}) {
  const href = resultPeakUrl("/admin", resultsUrl);

  return (
    <section className="mt-10 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-medium">Crest, colour and short name</h2>
      <p className="mt-2 text-sm text-muted">
        {schoolName}&rsquo;s crest, colour and short name are set once in
        ResultPeak, under School profile, and appear in both products.
      </p>
      {href ? (
        <a
          href={href}
          className="mt-3 inline-block text-sm font-medium text-brand hover:underline"
        >
          Open school profile in ResultPeak
        </a>
      ) : (
        <p className="mt-3 text-sm text-muted">
          Open ResultPeak and go to Admin, then School profile.
        </p>
      )}
    </section>
  );
}
