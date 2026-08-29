import { cache } from "react";
import type { Metadata } from "next";
import { getStudentSession } from "@/lib/auth/student";
import { brandingSchoolId } from "@/lib/routing/request-school";
import { getSchoolBrand } from "@/lib/branding/school";
import SignOutButton from "@/components/SignOutButton";
import AppHeader from "@/components/ui/AppHeader";
import SchoolTheme from "@/components/ui/SchoolTheme";
import StudentShell from "@/components/student/StudentShell";

/**
 * Which school this request is branded as.
 *
 * THE ORDER IS THE SECURITY PROPERTY, not a preference. A signed-in student is
 * branded from the SESSION, which is signed and server-verified. Only a visitor
 * with no session falls back to the hostname and then the cookie, and then the
 * worst case is a public school name and crest on a sign-in form. Reversing
 * these would let anyone put any school's identity above a child's own lessons
 * by visiting /s/{anything} first, or by pointing a DNS record at us
 * (docs/SCHOOL-BRANDING.md 6c).
 *
 * SESSION STILL BEATS HOSTNAME, and that ordering is unchanged by school
 * addresses. A child signed in at one school who opens another school's address
 * keeps seeing her own school above her own lessons, which is the honest answer:
 * the lessons on the page are hers, and the hostname decides nothing about them.
 *
 * React cache(): generateMetadata and the layout body both need this, and they
 * are two separate calls in the same request. Without it every page load
 * resolves the session and the brand twice.
 */
const brandForRequest = cache(async () => {
  const session = await getStudentSession();
  const schoolId = session ? session.schoolId : await brandingSchoolId();
  const brand = schoolId ? await getSchoolBrand(schoolId) : null;
  return { session, brand };
});

/**
 * The school's name in the tab, not the product's.
 *
 * Overrides the root template ("%s · JDSmartLearn"), which is the same
 * school-leads change the header makes. A tab is chrome a parent glances at over
 * a child's shoulder, and it should say where they are.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { brand } = await brandForRequest();
  if (!brand) return {};
  return {
    title: { default: brand.name, template: `%s · ${brand.shortName}` },
    /**
     * The school's crest in the tab, beside the school's name.
     *
     * Keyed by schoolId like everything else here, so a school on /s/{slug} and
     * a school on a domain it bought get the same icon: the address tier must
     * not change how a school looks.
     *
     * Omitted rather than defaulted when there is no crest, so Next falls back
     * to the product icon in /app rather than rendering a broken one.
     */
    icons: brand.crestUrl ? { icon: brand.crestUrl } : undefined,
  };
}

/**
 * Student shell: school brand + sign-out. The sign-in page renders without the
 * button but keeps the brand, which is the point - a child should recognise
 * their school before they type anything.
 *
 * Renders no student-identifying data, which is what makes it safe for the
 * service worker to cache this chrome and reuse it for whoever holds the phone
 * next. A school name is not student-identifying, and one student's cache per
 * device is enforced separately by boot().
 */
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const { session, brand } = await brandForRequest();

  return (
    <>
      <SchoolTheme brand={brand} />
      <AppHeader
        home="/student"
        brand={brand}
        action={
          session && (
            <SignOutButton
              endpoint="/api/student/session"
              redirectTo="/student/sign-in"
              wipeOffline
            />
          )
        }
      />
      {session && <StudentShell studentId={session.studentId} schoolId={session.schoolId} />}
      {children}
    </>
  );
}
