"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { boot, watchConnection } from "@/lib/offline/boot";
import OfflineBar from "./OfflineBar";

/**
 * Runs the offline lifecycle once per app open, and wires the on-demand sync
 * triggers. Mounted by the student layout, so every student route gets it.
 *
 * `studentId` comes from the server-verified session, which is what lets boot()
 * decide whether this phone's saved lessons belong to the person now holding it.
 */
export default function StudentShell({ studentId }: { studentId: string }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await boot(studentId);
      if (cancelled) return;
      // The store was wiped: either the grace window closed or the roster says
      // this account is gone. Either way the student must reach the network and
      // sign in again.
      if (result.needsSignIn) router.replace("/student/sign-in?expired=1");
    })();

    const stop = watchConnection();
    return () => {
      cancelled = true;
      stop();
    };
  }, [studentId, router]);

  return <OfflineBar />;
}
