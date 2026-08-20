"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import Field, { CONTROL } from "@/components/ui/Field";
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
    <main className="mx-auto max-w-sm px-5 py-12">
      <h1 className="text-title">Open your lessons</h1>
      <p className="mt-2 text-muted">Your teacher gives you these.</p>

      {expired && (
        <Callout tone="neutral" className="mt-5">
          Sign in again to read your lessons. You&rsquo;ll need internet once.
        </Callout>
      )}

      <Card className="mt-6 space-y-4 p-4">
        {chosen ? (
          <p className="flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2.5 text-sm">
            <span className="truncate font-medium">{chosen.name}</span>
            <Link
              href="/student/sign-in?school=change"
              className="shrink-0 font-medium text-accentText"
            >
              Change school
            </Link>
          </p>
        ) : (
          <Field label="Your school" htmlFor="school">
            <select
              id="school"
              value={schoolId}
              onChange={(e) => setSchoolId(e.target.value)}
              className={CONTROL}
            >
              {schools.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Your username" htmlFor="username">
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="jss3-04"
            className={`${CONTROL} lowercase`}
          />
        </Field>

        <Field label="Code" htmlFor="code">
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            // Set in the display face with even tracking: this is read off a
            // slip of paper and typed one character at a time.
            className={`${CONTROL} tabular text-lg tracking-[0.25em]`}
          />
        </Field>

        {error && <Callout tone="danger">{error}</Callout>}

        {schools.length === 0 && (
          <Callout tone="neutral">No schools are set up yet. Ask your teacher.</Callout>
        )}

        <Button
          onClick={signIn}
          disabled={busy || !username || !code || !schoolId}
          size="lg"
          full
        >
          {busy ? "Opening…" : "Open my lessons"}
        </Button>
      </Card>
    </main>
  );
}
