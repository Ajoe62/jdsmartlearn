"use client";
import { useState } from "react";

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
 *
 * READ-ONLY BY DESIGN. There used to be a "Create usernames" button here, and
 * removing it is the fix rather than a simplification: a tutor pressing it
 * minted a SECOND username for a child who already had one on the school
 * office's printed sheet. A username is half of a credential, and credentials
 * are issued once, by the school office, in ResultPeak. When one is missing this
 * page says who fixes it instead of offering to.
 */
export default function SignInCards({
  className,
  students,
  blocked,
  resultPeakUrl,
}: {
  className: string;
  students: StudentCard[];
  blocked: string[];
  /** ResultPeak's admin area, or null when this deployment has no link to it. */
  resultPeakUrl: string | null;
}) {
  const [showCodes, setShowCodes] = useState(false);

  const missing = students.filter((s) => !s.username).length;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h2 className="text-lg font-medium">{className}</h2>
        {students.length > 0 && (
          <button
            onClick={() => setShowCodes((v) => !v)}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm hover:border-brand"
          >
            {showCodes ? "Hide codes" : "Show codes"}
          </button>
        )}
      </div>

      {missing > 0 && (
        <p className="mt-4 rounded-lg border border-line bg-canvas p-4 text-sm text-muted print:hidden">
          {missing} student{missing === 1 ? " in" : "s in"} {className} {missing === 1 ? "has" : "have"}{" "}
          no sign-in yet. Usernames and access codes are issued by your school office in{" "}
          {resultPeakUrl ? (
            <a href={resultPeakUrl} className="font-medium text-ink underline hover:text-brand">
              ResultPeak
            </a>
          ) : (
            "ResultPeak"
          )}
          , on the School Setup page. Ask them to run the roster import for this class; it
          issues only what is missing and changes nobody&rsquo;s existing sign-in.
        </p>
      )}

      {students.length === 0 && (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
          Nobody in {className} has an access code yet. Ask your school admin to issue
          them in ResultPeak, then come back here.
        </p>
      )}

      {students.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          {students.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 p-4">
              <p className="min-w-0 truncate">{s.name}</p>
              <p className="shrink-0 text-right">
                <span className="block font-mono text-sm font-medium">
                  {s.username ?? "no username yet"}
                </span>
                <span className="block font-mono text-sm tracking-widest text-muted">
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
          <p className="mt-1 text-sm text-muted">
            These students have no access code. Ask your school admin to issue one in
            ResultPeak.
          </p>
          <ul className="mt-3 rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
            {blocked.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
