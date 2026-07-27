import Link from "next/link";
import { getStudentSession } from "@/lib/auth/student";
import SignOutButton from "@/components/SignOutButton";
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
      <header className="border-b border-line bg-chalk">
        <div className="mx-auto flex max-w-readable items-center justify-between px-5 py-3">
          <Link href="/student" className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- local SVG, no optimization needed */}
            <img src="/logo-horizontal.svg" alt="JDSmartLearn" width={140} height={28} />
          </Link>
          {session && (
            <SignOutButton
              endpoint="/api/student/session"
              redirectTo="/student/sign-in"
              wipeOffline
            />
          )}
        </div>
      </header>
      {session && <StudentShell studentId={session.studentId} />}
      {children}
    </>
  );
}
