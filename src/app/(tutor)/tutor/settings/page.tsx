import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { getSchool } from "@/lib/db/resultpeak";
import { getColumnSetting, getCurrentTermSession } from "@/lib/db/school-settings";
import SchoolSettingsForm from "./SchoolSettingsForm";
import { isAdminColumnAllowed, type AdminColumnInfo } from "@/lib/assessment/ca";
import { getSchoolBrand } from "@/lib/branding/school";
import { resultPeakUrl } from "@/lib/partner-links";

/**
 * Assessment settings. SCHOOL ADMIN ONLY, and rarely opened.
 *
 * The term and session are SHOWN here, never edited: they are ResultPeak's,
 * saved in its School profile, and both products read the same two fields. The
 * only setting saved here is which report-card column older assignments feed.
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

  const [calendar, current, school, brand] = await Promise.all([
    getCurrentTermSession(session.schoolId),
    getColumnSetting(session.schoolId),
    getSchool(session.schoolId),
    getSchoolBrand(session.schoolId),
  ]);

  // ResultPeak's own list, by its stable `value`. Never a default of ours.
  const allTypes =
    (school as { assessmentTypes?: (AdminColumnInfo & { label: string; maxScore: number })[] } | null)
      ?.assessmentTypes ?? [];
  // Exam and system columns are never offered (isAdminColumnAllowed).
  const assessmentTypes = allTypes
    .filter((t) => isAdminColumnAllowed(t, allTypes))
    .map((t) => ({ value: t.value, label: t.label, maxScore: t.maxScore }));
  // A column chosen before this check existed, now refused: say so, by name.
  const savedType = current.lmsAssessmentType;
  const blocked = savedType && !assessmentTypes.some((t) => t.value === savedType)
    ? allTypes.find((t) => t.value === savedType) ?? null
    : null;

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/tutor" className="text-sm text-muted">
        Back to your lessons
      </Link>
      <h1 className="mt-3 text-title">Assessment settings</h1>
      <p className="mt-2 text-muted">
        These decide which term new work counts towards, and which column its
        score lands in on the result sheet.
      </p>

      <CurrentTermNotice
        calendar={calendar}
        profileUrl={resultPeakUrl("/admin", brand?.resultsUrl ?? null)}
      />

      <SchoolSettingsForm
        current={current}
        assessmentTypes={assessmentTypes}
        blockedColumnLabel={blocked ? (blocked.label ?? blocked.value) : null}
      />

      {brand && (
        <BrandingNotice schoolName={brand.name} resultsUrl={brand.resultsUrl} />
      )}
    </main>
  );
}

/**
 * The current term, read from ResultPeak's School profile and shown, not edited.
 * One place to set it, so the two products can never name different terms.
 */
function CurrentTermNotice({
  calendar,
  profileUrl,
}: {
  calendar: { term: string; session: string } | null;
  profileUrl: string | null;
}) {
  const where = profileUrl ? (
    <a href={profileUrl} className="mt-3 inline-block text-sm font-medium text-brand hover:underline">
      Open school profile in ResultPeak
    </a>
  ) : (
    <p className="mt-3 text-sm text-muted">Open ResultPeak and go to Admin, then School profile.</p>
  );
  return (
    <section className="mt-8 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-medium">Current term</h2>
      {calendar ? (
        <p className="mt-2">
          {calendar.term}, {calendar.session}
        </p>
      ) : (
        <p role="alert" className="mt-2 rounded-lg bg-dangerSoft px-3 py-2 text-sm text-danger">
          Your school has not set its current term yet. Teachers cannot set new work
          until it is set.
        </p>
      )}
      <p className="mt-2 text-sm text-muted">
        Set in ResultPeak, under School profile. Both products use it, so marks
        always count towards the same term in each.
      </p>
      {where}
    </section>
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
