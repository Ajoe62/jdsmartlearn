"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CONTROL } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

function localTime(value: number | null) {
  if (value === null) return "";
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export default function ScheduleForm({ id, opensAt, closesAt, dueDate, updatedAt }: { id: string; opensAt: number | null; closesAt: number | null; dueDate: number; updatedAt: number }) {
  const router = useRouter();
  const [opening, setOpening] = useState("");
  const [closing, setClosing] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOpening(localTime(opensAt)); setClosing(localTime(closesAt)); setDue(localTime(dueDate)); }, [opensAt, closesAt, dueDate]);
  async function save() {
    const start = new Date(opening).getTime(), end = new Date(closing).getTime(), deadline = new Date(due).getTime();
    if (![start,end,deadline].every(Number.isFinite) || end <= start || deadline > end) { setError("Choose both visibility times. Closing must be after opening, and the due date must be on or before closing."); return; }
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/tutor/assignments/${encodeURIComponent(id)}/schedule`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opensAt: start, closesAt: end, dueDate: deadline, baseUpdatedAt: updatedAt }) });
      if (!res.ok) { const body = await res.json(); throw new Error(body.error || "Could not save the schedule."); }
      router.push(`/tutor/assignments/${id}/submissions`); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the schedule."); setBusy(false); }
  }
  return <div className="mt-6 space-y-4">
    <p className="text-sm text-muted">Students cannot see this assignment before the opening time. It disappears after the closing time. Inactive assignments remain hidden.</p>
    <label className="block text-sm">Show to students from<input type="datetime-local" value={opening} onChange={e => setOpening(e.target.value)} className={CONTROL} /></label>
    <label className="block text-sm">Hide from students after<input type="datetime-local" value={closing} onChange={e => setClosing(e.target.value)} className={CONTROL} /></label>
    <label className="block text-sm">Submission due date<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} className={CONTROL} /></label>
    <p className="text-sm text-muted">Saving changes student access immediately. Existing submissions and marks are kept.</p>
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save schedule"}</Button>
  </div>;
}
