import { brandingSchoolId } from "@/lib/routing/request-school";
import { getSchoolBrand } from "@/lib/branding/school";
import TutorSignInForm from "./TutorSignInForm";

/**
 * The staff door.
 *
 * A server component wrapping the credential form, so the school this device
 * belongs to can be named before anyone signs in. Until now this page was a bare
 * email-and-password form with "Use the same details as ResultPeak" on it - true,
 * and the single most third-party sentence in the product, because it told a
 * teacher that the thing their school had linked them to was really somebody
 * else's system.
 *
 * THERE IS NO SCHOOL PICKER HERE AND NEVER WAS. A member of staff cannot choose
 * a school anywhere in this product: `schoolId` arrives on their Firebase custom
 * claims and is not selectable. The school named below is context, not an input
 * - it is not submitted, and it does not decide what the account can reach.
 *
 * The brand comes from a cookie because there is no session yet, and a cookie is
 * attacker-supplied. That is acceptable for a public school name and crest on a
 * signed-out page, and it stops being acceptable the moment a session exists -
 * see the layout, which switches to the session (docs/SCHOOL-BRANDING.md 6c).
 */
export default async function TutorSignInPage() {
  const schoolId = await brandingSchoolId();
  const brand = schoolId ? await getSchoolBrand(schoolId) : null;

  return (
    <main className="mx-auto max-w-sm px-5 py-12">
      <h1 className="text-title">Sign in</h1>
      <p className="mt-2 text-muted">
        {brand
          ? `Teachers and admins at ${brand.shortName}. Use the email and password you already have.`
          : "Use the email and password you already have."}
      </p>

      <TutorSignInForm />
    </main>
  );
}
