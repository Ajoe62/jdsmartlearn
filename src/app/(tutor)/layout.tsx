import Link from "next/link";
import { getTutorSession } from "@/lib/auth/tutor";
import SignOutButton from "@/components/SignOutButton";
import TutorShell from "@/components/tutor/TutorShell";

/** Tutor shell: brand + sign-out. The sign-in page renders without the button. */
export default async function TutorLayout({ children }: { children: React.ReactNode }) {
  const session = await getTutorSession();

  return (
    <>
      <header className="border-b border-line bg-chalk">
        <div className="mx-auto flex max-w-readable items-center justify-between px-5 py-3">
          <Link href="/tutor" className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- local SVG, no optimization needed */}
            <img src="/logo-horizontal.svg" alt="JDSmartLearn" width={140} height={28} />
          </Link>
          {session && (
            <SignOutButton
              endpoint="/api/tutor/session"
              redirectTo="/tutor/sign-in"
              wipeTutorOffline
            />
          )}
        </div>
      </header>
      {session && <TutorShell uid={session.uid} />}
      {children}
    </>
  );
}
