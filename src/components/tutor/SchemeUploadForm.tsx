"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import Field, { CONTROL } from "@/components/ui/Field";
import { subjectsForClass } from "@/lib/auth/subject-access";

/**
 * Upload a scheme of work.
 *
 * THERE IS NO GENERATE BUTTON HERE AND THERE MUST NOT BE. A scheme is the
 * school's own curriculum document; a model rewriting it would invent curriculum
 * a class is then taught against, and it would spend the daily generation cap on
 * something nobody asked to be written (CLAUDE.md, Scheme of work rules).
 *
 * The class and subject pickers narrow to what this tutor teaches, which is a
 * convenience - /api/schemes re-checks both against ResultPeak on the request.
 */

const MAX_WEEKS = 20;

interface WeekRow {
  week: number;
  topic: string;
}

export default function SchemeUploadForm({
  classes,
  subjects,
  teachable,
}: {
  classes: { id: string; name: string }[];
  subjects: { id: string; name: string }[];
  /** subjectId -> classIds. `{}` means no restriction - see subject-access. */
  teachable: Record<string, string[]>;
}) {
  const router = useRouter();

  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Narrows with the class, so a tutor cannot be offered a pair they do not
  // teach. The same helper the lesson form uses.
  const available = useMemo(
    () => subjectsForClass(teachable, subjects, classId),
    [teachable, subjects, classId]
  );
  const [subjectId, setSubjectId] = useState(available[0]?.id ?? "");

  // The class changed and the chosen subject is no longer offered with it.
  const effectiveSubject = available.some((s) => s.id === subjectId)
    ? subjectId
    : (available[0]?.id ?? "");

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      const form = new FormData();
      form.set("classId", classId);
      form.set("subjectId", effectiveSubject);
      form.set("title", title);
      form.set("text", text);
      form.set("publish", String(publish));
      form.set("weeks", JSON.stringify(weeks.filter((w) => w.topic.trim())));
      if (file) form.set("file", file);

      const res = await fetch("/api/schemes", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });

      if (!res.ok) {
        // The server's own message - it names the field to fix.
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "We couldn't save that. Try again.");
        return;
      }

      router.push("/tutor/schemes");
      router.refresh();
    } catch {
      setError("We couldn't reach the internet. Your scheme of work was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="mt-6 space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Class" htmlFor="scheme-class">
        <select
          id="scheme-class"
          className={CONTROL}
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
        >
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Subject" htmlFor="scheme-subject">
        <select
          id="scheme-subject"
          className={CONTROL}
          value={effectiveSubject}
          onChange={(e) => setSubjectId(e.target.value)}
        >
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Title" htmlFor="scheme-title">
        <input
          id="scheme-title"
          className={CONTROL}
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="JSS2 Basic Science scheme of work"
        />
      </Field>

      <Field
        label="Upload the document"
        hint="PDF, Word or plain text, up to 10 MB. Students read the text on a slow connection and can open the original."
        htmlFor="scheme-file"
      >
        <input
          id="scheme-file"
          type="file"
          className={CONTROL}
          accept=".pdf,.docx,.txt"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>

      <Field
        label="Or paste it"
        hint="Use this if you don't have a file to hand."
        htmlFor="scheme-text"
      >
        <textarea
          id="scheme-text"
          className={CONTROL}
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>

      <WeekEditor weeks={weeks} onChange={setWeeks} />

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={publish}
          onChange={(e) => setPublish(e.target.checked)}
        />
        <span>
          <span className="font-medium">Let students see it straight away</span>
          <span className="mt-0.5 block text-muted">
            You can take it down at any time. Unlike a lesson, nothing here is
            written by AI, so there is nothing to review first.
          </span>
        </span>
      </label>

      {error && <Callout tone="danger">{error}</Callout>}

      <Button type="submit" full size="lg" disabled={saving || !classId || !effectiveSubject}>
        {saving ? "Saving…" : publish ? "Save and publish" : "Save as draft"}
      </Button>
    </form>
  );
}

/**
 * The optional week-by-week outline.
 *
 * Optional on purpose: most schools have a document already and typing it again
 * is exactly the busywork this product exists to remove. It is here for the
 * tutor who has a plan in their head and no file.
 */
function WeekEditor({
  weeks,
  onChange,
}: {
  weeks: WeekRow[];
  onChange: (rows: WeekRow[]) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">Week by week (optional)</legend>
      <p className="mt-0.5 text-sm text-muted">
        Students see this as a list. Leave it empty if your document already has it.
      </p>

      {weeks.length > 0 && (
        <ul className="mt-3 space-y-2">
          {weeks.map((row, index) => (
            <li key={index} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-sm text-muted">Week {row.week}</span>
              <input
                className={CONTROL}
                value={row.topic}
                maxLength={200}
                placeholder="What you will cover"
                onChange={(e) => {
                  const next = [...weeks];
                  next[index] = { ...row, topic: e.target.value };
                  onChange(next);
                }}
              />
              <Button
                variant="ghost"
                onClick={() => onChange(weeks.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {weeks.length < MAX_WEEKS && (
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => onChange([...weeks, { week: weeks.length + 1, topic: "" }])}
        >
          Add week {weeks.length + 1}
        </Button>
      )}
    </fieldset>
  );
}
