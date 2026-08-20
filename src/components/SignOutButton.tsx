"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { wipeDevice } from "@/lib/offline/wipe";
import { destroyTutorStore } from "@/lib/offline/tutor-db";

/** Clears the session cookie via the given endpoint, then returns to sign-in. */
export default function SignOutButton({
  endpoint,
  redirectTo,
  /** Students keep lessons on the phone; signing out must leave nothing behind. */
  wipeOffline = false,
  /** Tutor drafts can hold marking guides; they must not survive sign-out. */
  wipeTutorOffline = false,
}: {
  endpoint: string;
  redirectTo: string;
  wipeOffline?: boolean;
  wipeTutorOffline?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch(endpoint, { method: "DELETE" });
    } finally {
      // Before navigating: a shared phone must not hand the next person the
      // previous one's saved lessons or drafts.
      if (wipeOffline) await wipeDevice();
      if (wipeTutorOffline) await destroyTutorStore();
      router.push(redirectTo);
      router.refresh();
    }
  }

  return (
    <Button variant="secondary" onClick={signOut} disabled={busy} className="text-muted">
      {busy ? "Signing out…" : "Sign out"}
    </Button>
  );
}
