"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CONTROL } from "@/components/ui/Field";
import { RESULTPEAK_TERMS } from "@/lib/academic-calendar";

/**
 * The admin sets term, session, and which assessment column the LMS feeds.
 *
 * The session is PICKED FROM OBSERVED DATA, not typed. Each option shows how
 * many exams and results carry it and when it was last used, so an admin can
 * see which string their school is really operating under. Free text is behind
 * an explicit toggle with a plain warning, because a session ResultPeak has
 * never used will not appear on any result sheet.
 *
 * Nothing here trims or reshapes what is chosen.
 */


interface ObservedSession {
  session: string;
  count: number;
  lastUsedAt: number | null;
}

interface AssessmentType {
  value: string;
  label: string;
  maxScore: number;
}

export default function SchoolSettingsForm({
  current,
  sessions,
  assessmentTypes,
}: {
  current: {
    term: string;
    session: string;
    sessionIsOverride: boolean;
    lmsAssessmentType: string | null;
  } | null;
  sessions: ObservedSession[];
  assessmentTypes: AssessmentType[];
}) {
  const router = useRouter();
  const [term, setTerm] = useState(current?.term ?? "");
  const [session, setSession] = useState(current?.session ?? "");
  const [override, setOverride] = useState(current?.sessionIsOverride ?? false);
  const [lmsType, setLmsType] = useState(current?.lmsAssessmentType ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/tutor/school-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          term,
          session,
          sessionIsOverride: override,
          lmsAssessmentType: lmsType || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't save these settings.");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't save these settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-6">
      <label className="block">
        <span className="text-sm font-medium">Current term</span>
        <select value={term} onChange={(e) => setTerm(e.target.value)} className={CONTROL}>
          <option value="">Choose a term</option>
          {RESULTPEAK_TERMS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <div>
        <span className="text-sm font-medium">Current session</span>

        {override ? (
          <>
            <input
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder="2025/2026"
              className={CONTROL}
            />
            <p className="mt-2 rounded-lg border border-line bg-canvas p-3 text-sm">
              <span className="font-medium">Read this before saving.</span> Your school
              has never used this session in ResultPeak. Work counted under it will not
              appear on any result sheet until ResultPeak uses the same session, spelled
              exactly the same way.
            </p>
          </>
        ) : sessions.length === 0 ? (
          <p className="mt-1 rounded-lg border border-line bg-surface p-4 text-sm text-muted">
            No exams or results in ResultPeak yet, so there is no session to match. Turn
            on the option below to enter one.
          </p>
        ) : (
          <>
            <select
              value={session}
              onChange={(e) => setSession(e.target.value)}
              className={CONTROL}
            >
              <option value="">Choose a session</option>
              {sessions.map((s) => (
                <option key={s.session} value={s.session}>
                  {s.session} ({s.count} record{s.count === 1 ? "" : "s"}
                  {s.lastUsedAt ? `, last used ${new Date(s.lastUsedAt).toDateString()}` : ""})
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-muted">
              These are the sessions your school&rsquo;s own exams and results already
              use. Pick the one your marks should join.
            </p>
          </>
        )}

        <label className="mt-3 flex items-start gap-3">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => {
              setOverride(e.target.checked);
              setSession("");
            }}
            className="mt-1"
          />
          <span className="text-sm">
            Use a session that is not in my data
            <span className="block text-muted">
              Only if your school is starting a new session that has no exams yet.
            </span>
          </span>
        </label>
      </div>

      <div>
        <span className="text-sm font-medium">Which column LMS marks count towards</span>
        {assessmentTypes.length === 0 ? (
          <p className="mt-1 rounded-lg border border-line bg-surface p-4 text-sm text-muted">
            Your school has not set up its assessment structure in ResultPeak yet. Do
            that first, then come back here.
          </p>
        ) : (
          <>
            <select
              value={lmsType}
              onChange={(e) => setLmsType(e.target.value)}
              className={CONTROL}
            >
              <option value="">Not set. Marks stay in JDSmartLearn only</option>
              {assessmentTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} (out of {t.maxScore})
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-muted">
              While this is not set, marks you release stay in JDSmartLearn and are not
              sent to ResultPeak. Nothing is guessed for you: if your school has no
              column for coursework, leave it unset and add one in ResultPeak first.
            </p>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-line bg-canvas p-3 text-sm">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-lg border border-line bg-canvas p-3 text-sm">
          Saved. New assignments will use {term}, {session}.
        </p>
      )}

      <Button
        onClick={() => void save()}
        disabled={busy || !term || !session}
        size="lg"
        full
      >
        {busy ? "Saving" : "Save settings"}
      </Button>
    </div>
  );
}
