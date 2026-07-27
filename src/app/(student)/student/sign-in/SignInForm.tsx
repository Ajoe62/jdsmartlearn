"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { wipeDevice } from "@/lib/offline/wipe";
import type { SchoolListing } from "@/lib/db/resultpeak";

export default function SignInForm({
  schools,
  chosen,
  expired,
}: {
  schools: SchoolListing[];
  /** The school this phone already remembers, if any. */
  chosen: SchoolListing | null;
  expired: boolean;
}) {
  const router = useRouter();
  const [schoolId, setSchoolId] = useState(chosen?.id ?? schools[0]?.id ?? "");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Arriving here means no valid session, so nothing saved on this phone is
   * usable any more - the grace window closed, the account was deactivated, or
   * someone signed out. Clear it now rather than at the next sign-in, so a phone
   * left on this screen is not holding a previous student's lessons.
   */
  useEffect(() => {
    void wipeDevice();
  }, []);

  async function signIn() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/student/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schoolId, username, code }),
    });
    if (res.ok) {
      router.push("/student");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "That username and code don't match.");
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
        {chosen ? (
          <p className="flex items-center justify-between gap-3 rounded-lg border border-line bg-paper px-3 py-2 text-sm">
            <span className="truncate font-medium">{chosen.name}</span>
            <Link href="/student/sign-in?school=change" className="shrink-0 text-marker underline">
              Change school
            </Link>
          </p>
        ) : (
          <label className="block">
            <span className="text-sm font-medium">Your school</span>
            <select
              value={schoolId}
              onChange={(e) => setSchoolId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
            >
              {schools.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="text-sm font-medium">Your username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="jss3-04"
            className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2 lowercase"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2 text-lg tracking-widest"
          />
        </label>

        {error && (
          <p className="rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">{error}</p>
        )}

        {schools.length === 0 && (
          <p className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-slate">
            No schools are set up yet. Ask your teacher.
          </p>
        )}

        <button
          onClick={signIn}
          disabled={busy || !username || !code || !schoolId}
          className="w-full rounded-lg bg-marker px-4 py-3 font-medium text-chalk hover:bg-markerDark disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open my lessons"}
        </button>
      </div>
    </main>
  );
}
