"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CONTROL } from "@/components/ui/Field";

/**
 * The admin chooses which report-card column older assignments feed.
 *
 * Term and session are not here: they are set in ResultPeak's School profile
 * and shown read-only on the page above this form.
 */

interface AssessmentType {
  value: string;
  label: string;
  maxScore: number;
}

export default function SchoolSettingsForm({
  current,
  assessmentTypes,
  blockedColumnLabel = null,
}: {
  current: { lmsAssessmentType: string | null };
  assessmentTypes: AssessmentType[];
  /** The saved column, when it is an exam or system column and now refused. */
  blockedColumnLabel?: string | null;
}) {
  const router = useRouter();
  // A refused saved column starts blank, so saving cannot resubmit it.
  const [lmsType, setLmsType] = useState(
    blockedColumnLabel ? "" : current.lmsAssessmentType ?? ""
  );
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
        body: JSON.stringify({ lmsAssessmentType: lmsType || null }),
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
            {blockedColumnLabel && (
              <p role="alert" className="mt-1 rounded-lg bg-dangerSoft px-3 py-2 text-sm text-danger">
                Marks were set to count towards &ldquo;{blockedColumnLabel}&rdquo;, which is an
                exam or system column, so they are not being sent to report cards. Choose a
                coursework column and save.
              </p>
            )}
            <p className="mt-1 text-sm text-muted">
              Exam and system columns are not listed: homework must never fill them.
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
          Saved.
        </p>
      )}

      <Button
        onClick={() => void save()}
        disabled={busy}
        size="lg"
        full
      >
        {busy ? "Saving" : "Save settings"}
      </Button>
    </div>
  );
}
