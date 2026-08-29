import Link from "next/link";
import { redirect } from "next/navigation";
import { getTutorSession } from "@/lib/auth/tutor";
import { getClassesByIds, listClassesForSchool } from "@/lib/db/resultpeak";
import { getStudentsInClass } from "@/lib/db/resultpeak";
import { accessCodesFor, usernamesForStudents } from "@/lib/db/student-logins";
import { printableSchoolAddress } from "@/lib/db/school-domains";
import { getSchoolBrand } from "@/lib/branding/school";
import SchoolMark from "@/components/ui/SchoolMark";
import SignInCards from "./SignInCards";

/**
 * What each student in a class types to open their lessons.
 *
 * Tutor-only, and it shows live access codes - this route must NEVER be added
 * to the service worker allowlist, same rule as /tutor/lessons/[id].
 *
 * Reads only. Usernames live in JDSmartLearn; the students and their codes
 * belong to ResultPeak.
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

  const ids = students.map((s) => s.id);
  const [codes, usernames] = await Promise.all([
    accessCodesFor(ids),
    usernamesForStudents(session.schoolId, ids),
  ]);

  const ready = students
    .filter((s) => codes.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.fullName,
      username: usernames.get(s.id) ?? null,
      code: codes.get(s.id)!,
    }));

  const blocked = students.filter((s) => !codes.has(s.id)).map((s) => s.fullName);

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
        classId={selected.id}
        className={selected.name}
        students={ready}
        blocked={blocked}
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
