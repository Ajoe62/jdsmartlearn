import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { getSchool } from "@/lib/db/resultpeak";
import { getCurrentTermSession, observedSessions } from "@/lib/db/school-settings";
import SchoolSettingsForm from "./SchoolSettingsForm";
import BrandingForm from "./BrandingForm";
import { getSchoolBranding } from "@/lib/db/school-branding";
import { getSchoolBrand } from "@/lib/branding/school";

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

  const [current, sessions, school, branding, brand] = await Promise.all([
    getCurrentTermSession(session.schoolId),
    observedSessions(session.schoolId),
    getSchool(session.schoolId),
    getSchoolBranding(session.schoolId),
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

      {/* Branding sits under assessment settings rather than on a page of its
          own: both are school-wide, admin-only, and opened about twice a year.
          A second settings page would be a second thing to find. */}
      {brand && (
        <BrandingForm
          schoolId={session.schoolId}
          schoolName={brand.name}
          current={{
            shortName: branding.shortName,
            colorHex: branding.colorHex,
            motto: branding.motto,
            crestUrl: brand.crestUrl,
            logoIsIcon: branding.logoIsIcon,
          }}
        />
      )}
    </main>
  );
}
