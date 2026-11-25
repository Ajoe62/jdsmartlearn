"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CONTROL } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

function localTime(value: number | null) {
  if (value === null) return "";
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Edits the visibility window and due date.
 *
 * The fields are seeded ONCE from the server and then belong to the tutor. No
 * effect copies props back into them, so a refresh or a re-render can never
 * put old dates back over what was typed. After a save, the fields are set from
 * what the server says it stored, and `version` takes the new `updatedAt`, so
 * saving again from the same screen is not refused as stale.
 */
export default function ScheduleForm({ id, opensAt, closesAt, dueDate, updatedAt }: { id: string; opensAt: number | null; closesAt: number | null; dueDate: number; updatedAt: number }) {
  const router = useRouter();
  const [opening, setOpening] = useState(() => localTime(opensAt));
  const [closing, setClosing] = useState(() => localTime(closesAt));
  const [due, setDue] = useState(() => localTime(dueDate));
  const [version, setVersion] = useState(updatedAt);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // The "Schedule saved" message closes itself after a few seconds.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(t);
  }, [saved]);

  async function save() {
    const start = new Date(opening).getTime(), end = new Date(closing).getTime(), deadline = new Date(due).getTime();
    if (![start,end,deadline].every(Number.isFinite) || end <= start || deadline > end) { setError("Choose both visibility times. Closing must be after opening, and the due date must be on or before closing."); return; }
    setBusy(true); setError(""); setSaved(false);
    try {
      const res = await fetch(`/api/tutor/assignments/${encodeURIComponent(id)}/schedule`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opensAt: start, closesAt: end, dueDate: deadline, baseUpdatedAt: version }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; updatedAt?: number; opensAt?: number; closesAt?: number; dueDate?: number };
      if (!res.ok) throw new Error(body.error || "Could not save the schedule.");
      if (typeof body.updatedAt === "number") setVersion(body.updatedAt);
      if (typeof body.opensAt === "number") setOpening(localTime(body.opensAt));
      if (typeof body.closesAt === "number") setClosing(localTime(body.closesAt));
      if (typeof body.dueDate === "number") setDue(localTime(body.dueDate));
      setSaved(true);
      // Refresh other pages' copies (the assignment page, the list) without
      // touching these fields, which no longer read from props.
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the schedule."); }
    setBusy(false);
  }

  return <div className="mt-6 space-y-4">
    <p className="text-sm text-muted">Students cannot see this assignment before the opening time. It disappears after the closing time. Inactive assignments remain hidden.</p>
    <label className="block text-sm">Show to students from<input type="datetime-local" value={opening} onChange={e => { setOpening(e.target.value); setSaved(false); }} className={CONTROL} /></label>
    <label className="block text-sm">Hide from students after<input type="datetime-local" value={closing} onChange={e => { setClosing(e.target.value); setSaved(false); }} className={CONTROL} /></label>
    <label className="block text-sm">Submission due date<input type="datetime-local" value={due} onChange={e => { setDue(e.target.value); setSaved(false); }} className={CONTROL} /></label>
    <p className="text-sm text-muted">Saving changes student access immediately. Existing submissions and marks are kept.</p>
    {error && <p role="alert" className="rounded-lg bg-dangerSoft px-3 py-2 text-sm text-danger">{error}</p>}
    <div className="flex flex-wrap items-center gap-4">
      <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save schedule"}</Button>
      <Link href={`/tutor/assignments/${id}/submissions`} className="text-sm font-medium text-brand">Done</Link>
    </div>
    <div aria-live="polite" className="fixed inset-x-4 bottom-4 z-50 flex justify-center">
      {saved && (
        <p role="status" className="rounded-lg bg-success px-4 py-3 text-sm font-medium text-ink shadow-lg">
          Schedule saved successfully.
        </p>
      )}
    </div>
  </div>;
}
