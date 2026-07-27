import { getRememberedSchoolId } from "@/lib/auth/student";
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
  const [schools, remembered] = await Promise.all([
    getSchoolDirectory(),
    getRememberedSchoolId(),
  ]);

  // ?school=change re-opens the picker on a phone that already remembers one.
  const chosen =
    params.school === "change"
      ? null
      : (schools.find((s) => s.id === remembered) ?? null);

  return (
    <SignInForm
      schools={schools}
      chosen={chosen}
      expired={params.expired === "1"}
    />
  );
}
