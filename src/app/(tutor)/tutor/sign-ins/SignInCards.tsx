"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface StudentCard {
  id: string;
  name: string;
  username: string | null;
  code: string;
}

/**
 * The list a teacher reads from when handing out sign-ins.
 *
 * Codes are hidden until asked for: this is a live credential on a phone the
 * teacher may be holding in front of a class.
 */
export default function SignInCards({
  classId,
  className,
  students,
  blocked,
}: {
  classId: string;
  className: string;
  students: StudentCard[];
  blocked: string[];
}) {
  const router = useRouter();
  const [showCodes, setShowCodes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = students.filter((s) => !s.username).length;

  async function createUsernames() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/students/logins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId }),
    });
    if (res.ok) {
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "We couldn't create the usernames. Try again.");
    }
    setBusy(false);
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h2 className="text-lg font-medium">{className}</h2>
        <div className="flex gap-2">
          {students.length > 0 && (
            <button
              onClick={() => setShowCodes((v) => !v)}
              className="rounded-lg border border-line bg-chalk px-3 py-2 text-sm hover:border-marker"
            >
              {showCodes ? "Hide codes" : "Show codes"}
            </button>
          )}
          {missing > 0 && (
            <button
              onClick={createUsernames}
              disabled={busy}
              className="rounded-lg bg-marker px-4 py-2 text-sm font-medium text-chalk hover:bg-markerDark disabled:opacity-50"
            >
              {busy ? "Creating…" : `Create ${missing} username${missing === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">{error}</p>
      )}

      {students.length === 0 && (
        <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
          Nobody in {className} has an access code yet. Ask your school admin to issue
          them in ResultPeak, then come back here.
        </p>
      )}

      {students.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-chalk">
          {students.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 p-4">
              <p className="min-w-0 truncate">{s.name}</p>
              <p className="shrink-0 text-right">
                <span className="block font-mono text-sm font-medium">
                  {s.username ?? "no username yet"}
                </span>
                <span className="block font-mono text-sm tracking-widest text-slate">
                  {showCodes ? s.code : "••••••"}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}

      {blocked.length > 0 && (
        <section className="mt-8 print:hidden">
          <h3 className="text-sm font-medium">Can&rsquo;t sign in yet</h3>
          <p className="mt-1 text-sm text-slate">
            These students have no access code. Ask your school admin to issue one in
            ResultPeak.
          </p>
          <ul className="mt-3 rounded-lg border border-line bg-paper p-4 text-sm text-slate">
            {blocked.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
