import { getRememberedSchoolId } from "@/lib/auth/student";
import { brandingSchoolId, pinnedSchoolId } from "@/lib/routing/request-school";
import { getSchoolDirectory } from "@/lib/db/resultpeak";
import SignInForm from "./SignInForm";

/**
 * Students sign in with the username their teacher gave them (`jss3-04`) and
 * their access code. The school is picked once and remembered on the phone,
 * because a username is only unique inside a school.
 *
 * The school list is server-rendered so the form ships almost no JavaScript -
 * this page loads on a throttled 3G connection.
 */
export default async function StudentSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ expired?: string; school?: string }>;
}) {
  const params = await searchParams;
  const [schools, cookieRemembered, pinnedId, resolved] = await Promise.all([
    getSchoolDirectory(),
    getRememberedSchoolId(),
    pinnedSchoolId(),
    brandingSchoolId(),
  ]);

  // THE HOSTNAME BEATS THE COOKIE, here as everywhere. A phone that opened one
  // school's /s/ link a year ago must not preselect that school on a different
  // school's own address - the visitor typed the address, and the cookie is a
  // side effect they have forgotten about. See lib/routing/request-school.ts.
  const remembered = resolved ?? cookieRemembered;

  // ?school=change re-opens the picker on a phone that already remembers one.
  //
  // IT STILL WORKS ON A PINNED DEVICE, deliberately. The link is no longer shown
  // there - offering to leave the school is the brand risk this work removes -
  // but a child who genuinely transfers, or a phone handed between two schools,
  // must not be stranded with no way back. Stop advertising the escape hatch; do
  // not remove it. Signing in to a different school then releases the pin, in
  // /api/student/session.
  const wantsChange = params.school === "change";

  const chosen = wantsChange
    ? null
    : (schools.find((s) => s.id === remembered) ?? null);

  return (
    <SignInForm
      schools={schools}
      chosen={chosen}
      // Pinned only when the school's OWN link put this device here and it still
      // agrees with what the phone remembers. A stale pin for some other school
      // must not silently suppress the picker.
      pinned={!wantsChange && !!chosen && chosen.id === pinnedId}
      expired={params.expired === "1"}
    />
  );
}
