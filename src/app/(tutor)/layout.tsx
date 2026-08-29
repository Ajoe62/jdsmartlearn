import { cache } from "react";
import type { Metadata } from "next";
import { getTutorSession } from "@/lib/auth/tutor";
import { brandingSchoolId } from "@/lib/routing/request-school";
import { getSchoolBrand } from "@/lib/branding/school";
import SignOutButton from "@/components/SignOutButton";
import AppHeader from "@/components/ui/AppHeader";
import SchoolTheme from "@/components/ui/SchoolTheme";
import TutorShell from "@/components/tutor/TutorShell";

/**
 * Which school this request is branded as. Same rule as the student layout, and
 * for the same reason: SESSION when there is one, cookie only before sign-in.
 *
 * A member of staff never picks a school - `schoolId` arrives on their custom
 * claims and is not selectable anywhere in this product. So once they are signed
 * in the cookie is not merely unnecessary, it is the wrong answer: a teacher who
 * once opened another school's link would otherwise see that school's crest over
 * their own classes.
 *
 * brandingSchoolId() resolves the hostname first and the cookie only after, so
 * a member of staff who has not signed in yet sees the school whose address
 * they typed rather than whichever school this phone last opened a link for. It
 * carries no student data and is not a student session.
 *
 * React cache(): generateMetadata and the layout body both need this, and they
 * are two separate calls in the same request. Without it every page load
 * resolves the session and the brand twice.
 */
const brandForRequest = cache(async () => {
  const session = await getTutorSession();
  const schoolId = session ? session.schoolId : await brandingSchoolId();
  const brand = schoolId ? await getSchoolBrand(schoolId) : null;
  return { session, brand };
});

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

/** Tutor shell: school brand + sign-out. The sign-in page renders without the button. */
export default async function TutorLayout({ children }: { children: React.ReactNode }) {
  const { session, brand } = await brandForRequest();

  return (
    <>
      <SchoolTheme brand={brand} />
      <AppHeader
        home="/tutor"
        brand={brand}
        action={
          session && (
            <SignOutButton
              endpoint="/api/tutor/session"
              redirectTo="/tutor/sign-in"
              wipeTutorOffline
            />
          )
        }
      />
      {session && <TutorShell uid={session.uid} />}
      {children}
    </>
  );
}
