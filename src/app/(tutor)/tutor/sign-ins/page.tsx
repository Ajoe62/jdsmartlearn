import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { getClassesByIds, listClassesForSchool } from "@/lib/db/resultpeak";
import { getStudentsInClass } from "@/lib/db/resultpeak";
import { signInsForStudents } from "@/lib/db/student-logins";
import { printableSchoolAddress } from "@/lib/db/school-domains";
import { getSchoolBrand } from "@/lib/branding/school";
import { resultPeakStaffUrl } from "@/lib/partner-links";
import SchoolMark from "@/components/ui/SchoolMark";
import SignInCards from "./SignInCards";

/**
 * What each student in a class types to open their lessons.
 *
 * Tutor-only, and it shows live access codes - this route must NEVER be added
 * to the service worker allowlist, same rule as /tutor/lessons/[id].
 *
 * READS ONLY, AND EVERY VALUE ON THE SHEET IS RESULTPEAK'S. The username and
 * the access code are two fields of one `studentAccess` document, issued
 * together when the school office creates the student. This page cannot print a
 * username that differs from the office's own sheet, because there is only one.
 *
 * There is deliberately no way to create a sign-in from here. This repo issues
 * no credential at all - see lib/db/student-logins.ts.
 */
export default async function SignInsPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string }>;
}) {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const params = await searchParams;
  const classes = session.isAdmin
    ? await listClassesForSchool(session.schoolId)
    : await getClassesByIds(session.assignedClasses);

  const selected = classes.find((c) => c.id === params.class) ?? classes[0] ?? null;

  if (!selected) {
    return (
      <main className="mx-auto max-w-readable px-5 py-10">
        <Header />
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
          {session.isAdmin
            ? "No classes exist in this school yet. Create them in ResultPeak first."
            : "No classes are assigned to you yet. Ask your school admin to assign your classes in ResultPeak."}
        </p>
      </main>
    );
  }

  const students = (await getStudentsInClass(session.schoolId, selected.id))
    .filter((s) => s.isActive !== false)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  // One getAll over studentAccess: the username and the code are fields of the
  // same document, so there is nothing to join and nothing that can disagree.
  const signIns = await signInsForStudents(session.schoolId, students.map((s) => s.id));

  const ready = students
    .filter((s) => signIns.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.fullName,
      username: signIns.get(s.id)!.username,
      code: signIns.get(s.id)!.code,
    }));

  const blocked = students.filter((s) => !signIns.has(s.id)).map((s) => s.fullName);

  /**
   * The school on the sheet comes from the SESSION, never the hostname. A tutor
   * printing from one school's address must not put another school's crest on
   * a sheet that goes home with a child.
   */
  const brand = await getSchoolBrand(session.schoolId);
  const address = brand ? await printableSchoolAddress(session.schoolId, brand.slug) : null;

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Header />
      {brand && <Masthead brand={brand} address={address} />}

      {classes.length > 1 && (
        <div className="mt-5 flex flex-wrap gap-2 print:hidden">
          {classes.map((c) => (
            <Link
              key={c.id}
              href={`/tutor/sign-ins?class=${c.id}`}
              className={`rounded-full border px-3 py-1 text-sm ${
                c.id === selected.id
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface hover:border-brand"
              }`}
            >
              {c.name}
            </Link>
          ))}
        </div>
      )}

      <SignInCards
        className={selected.name}
        students={ready}
        blocked={blocked}
        resultPeakUrl={resultPeakStaffUrl(brand?.resultsUrl) || null}
      />
    </main>
  );
}

/**
 * THE SCHOOL'S OWN NAME, CREST AND ADDRESS, at the top of the sheet a parent
 * ends up holding.
 *
 * These cards are the real front door: for most parents this piece of paper is
 * the first time the product exists at all, and it should read as something
 * their school issued rather than something a supplier did. The school leads and
 * JDSmartLearn is not mentioned (CLAUDE.md, school branding rules).
 *
 * Shown on screen as well as in print, so a tutor can see what will come out of
 * the printer before spending a sheet on thirty children.
 *
 * The address is the school's NOMINATED primary, not the hostname this page was
 * served on - see printableSchoolAddress. A sheet printed today must keep
 * working the day the school moves to a domain it bought.
 */
function Masthead({
  brand,
  address,
}: {
  brand: NonNullable<Awaited<ReturnType<typeof getSchoolBrand>>>;
  address: string | null;
}) {
  return (
    <div className="mt-6 flex items-center gap-3 border-b border-line pb-4">
      <SchoolMark brand={brand} size="lg" />
      <div className="min-w-0">
        <p className="truncate font-display text-lg font-semibold">{brand.name}</p>
        {address && (
          <p className="truncate text-sm text-muted">
            Sign in at <span className="font-medium text-ink">{address}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="print:hidden">
      <Link href="/tutor" className="text-sm text-muted hover:text-ink">
        ← Your lessons
      </Link>
      <h1 className="mt-2 text-title">Student sign-ins</h1>
      <p className="mt-2 text-sm text-muted">
        Give each student their username and code. They only need them once on a phone.
      </p>
    </div>
  );
}
