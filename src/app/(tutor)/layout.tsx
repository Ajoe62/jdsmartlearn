import { cache } from "react";
import type { Metadata } from "next";
import { getTutorSession } from "@/lib/auth/tutor";
import { getBrandingSchoolId } from "@/lib/auth/student";
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
 * getBrandingSchoolId() lives in lib/auth/student because that is where the
 * cookie is defined. It carries no student data and is not a student session.
 *
 * React cache(): generateMetadata and the layout body both need this, and they
 * are two separate calls in the same request. Without it every page load
 * resolves the session and the brand twice.
 */
const brandForRequest = cache(async () => {
  const session = await getTutorSession();
  const schoolId = session ? session.schoolId : await getBrandingSchoolId();
  const brand = schoolId ? await getSchoolBrand(schoolId) : null;
  return { session, brand };
});

export async function generateMetadata(): Promise<Metadata> {
  const { brand } = await brandForRequest();
  if (!brand) return {};
  return { title: { default: brand.name, template: `%s · ${brand.shortName}` } };
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
