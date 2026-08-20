import { getTutorSession } from "@/lib/auth/tutor";
import SignOutButton from "@/components/SignOutButton";
import AppHeader from "@/components/ui/AppHeader";
import TutorShell from "@/components/tutor/TutorShell";

/** Tutor shell: brand + sign-out. The sign-in page renders without the button. */
export default async function TutorLayout({ children }: { children: React.ReactNode }) {
  const session = await getTutorSession();

  return (
    <>
      <AppHeader
        home="/tutor"
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
