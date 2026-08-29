"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { boot, watchConnection } from "@/lib/offline/boot";
import { applySchoolColour } from "@/lib/branding/apply";
import { getMeta } from "@/lib/offline/db";
import OfflineBar from "./OfflineBar";

/**
 * Runs the offline lifecycle once per app open, and wires the on-demand sync
 * triggers. Mounted by the student layout, so every student route gets it.
 *
 * `studentId` comes from the server-verified session, which is what lets boot()
 * decide whether this phone's saved lessons belong to the person now holding it.
 */
export default function StudentShell({
  studentId,
  schoolId,
}: {
  studentId: string;
  /** From the session, never the hostname. A change wipes the device store. */
  schoolId: string;
}) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Before boot(), so the offline shell is the school's colour on the very
      // first paint rather than after a sync round-trip. The server-rendered
      // <SchoolTheme /> already covers the online path; this is the correction
      // for a cached shell. See lib/branding/apply.
      applySchoolColour((await getMeta())?.brand);

      const result = await boot(studentId, schoolId);
      if (cancelled) return;
      // The store was wiped: either the grace window closed or the roster says
      // this account is gone. Either way the student must reach the network and
      // sign in again.
      if (result.needsSignIn) router.replace("/student/sign-in?expired=1");

      // The sync inside boot() may have brought a new crest or colour.
      applySchoolColour((await getMeta())?.brand);
    })();

    const stop = watchConnection();
    return () => {
      cancelled = true;
      stop();
    };
  }, [studentId, schoolId, router]);

  return <OfflineBar />;
}
