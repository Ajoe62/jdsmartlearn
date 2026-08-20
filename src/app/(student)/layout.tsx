import { getStudentSession } from "@/lib/auth/student";
import SignOutButton from "@/components/SignOutButton";
import AppHeader from "@/components/ui/AppHeader";
import StudentShell from "@/components/student/StudentShell";

/**
 * Student shell: brand + sign-out. The sign-in page renders without the button.
 *
 * Renders no student-identifying data, which is what makes it safe for the
 * service worker to cache this chrome and reuse it for whoever holds the phone
 * next.
 */
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const session = await getStudentSession();

  return (
    <>
      <AppHeader
        home="/student"
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
      {session && <StudentShell studentId={session.studentId} />}
      {children}
    </>
  );
}
