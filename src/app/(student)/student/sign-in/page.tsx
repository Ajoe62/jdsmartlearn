"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { wipeDevice } from "@/lib/offline/wipe";

/** Students sign in with their ID and access code - no email, no app. */
export default function StudentSignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const [studentId, setStudentId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Arriving here means no valid session, so nothing saved on this phone is
   * usable any more - the grace window closed, the account was deactivated, or
   * someone signed out. Clear it now rather than at the next sign-in, so a phone
   * left on this screen is not holding a previous student's lessons.
   */
  const expired = params.get("expired") === "1";
  useEffect(() => {
    void wipeDevice();
  }, []);

  async function signIn() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/student/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId, code }),
    });
    if (res.ok) {
      router.push("/student");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "That ID and code don't match.");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm px-5 py-16">
      <h1 className="text-2xl font-semibold">Open your lessons</h1>
      <p className="mt-2 text-sm text-slate">Your teacher gives you these.</p>

      {expired && (
        <p className="mt-4 rounded-lg border border-line bg-paper px-3 py-2 text-sm text-slate">
          Sign in again to read your lessons. You&rsquo;ll need internet once.
        </p>
      )}

      <div className="mt-8 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Student ID</span>
          <input
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Code</span>
          <input
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2 text-lg tracking-widest"
          />
        </label>

        {error && (
          <p className="rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">{error}</p>
        )}

        <button
          onClick={signIn}
          disabled={busy || !studentId || !code}
          className="w-full rounded-lg bg-marker px-4 py-3 font-medium text-chalk hover:bg-markerDark disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open my lessons"}
        </button>
      </div>
    </main>
  );
}
