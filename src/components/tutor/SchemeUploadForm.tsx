"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import Field, { CONTROL } from "@/components/ui/Field";
import FileUploadField, { type UploadedFile } from "@/components/tutor/FileUploadField";
import {
  subjectsForClass,
  unmatchedState,
  type UnmatchedClasses,
} from "@/lib/auth/subject-access";
import UnmatchedClassNote from "@/components/tutor/UnmatchedClassNote";
import {
  MAX_TUTOR_FILE_BYTES,
  TUTOR_UPLOAD_LABEL,
  formatLimit,
} from "@/lib/storage/file-types";
import { readApiError } from "@/lib/upload-client";

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
  unmatched,
  filesAvailable,
}: {
  classes: { id: string; name: string }[];
  subjects: { id: string; name: string }[];
  /** subjectId -> classIds. `{}` means no restriction - see subject-access. */
  teachable: Record<string, string[]>;
  /** Held classes with no subject set for this tutor - see pickerAllocation(). */
  unmatched: UnmatchedClasses;
  /** False when R2 is not configured: paste or type the weeks instead. */
  filesAvailable: boolean;
}) {
  const router = useRouter();

  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  /** The document, once it has reached storage. */
  const [upload, setUpload] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Narrows with the class, so a tutor cannot be offered a pair they do not
  // teach. The same helper the lesson form uses.
  // A class with no subject set for this tutor: "open" lists every subject,
  // "blocked" none, and the form says why either way. See pickerAllocation().
  const classGap = unmatchedState(unmatched, classId);
  const available = useMemo(
    () => (classGap === "blocked" ? [] : subjectsForClass(teachable, subjects, classId)),
    [teachable, subjects, classId, classGap]
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
      const res = await fetch("/api/schemes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          classId,
          subjectId: effectiveSubject,
          title,
          text,
          publish,
          weeks: weeks.filter((w) => w.topic.trim()),
          // The document itself is already in storage; this names it.
          ...(upload ? { uploadKey: upload.uploadKey, fileName: upload.name } : {}),
        }),
      });

      if (!res.ok) {
        // The server's own message - it names the field to fix.
        setError(await readApiError(res, "We couldn't save that. Try again."));
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
          disabled={available.length === 0}
        >
          {available.length === 0 && <option value="">No subjects for this class</option>}
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      {classGap && (
        <UnmatchedClassNote
          classLabel={classes.find((c) => c.id === classId)?.name ?? "this class"}
          state={classGap}
          noun="schemes of work"
        />
      )}

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

      {filesAvailable ? (
        <FileUploadField
          id="scheme-file"
          label="Upload the document"
          hint={`${TUTOR_UPLOAD_LABEL}, up to ${formatLimit(MAX_TUTOR_FILE_BYTES)}. Students can open the original, and read its text on a slow connection when it is a PDF or Word file.`}
          purpose="scheme"
          value={upload}
          onChange={setUpload}
          onBusyChange={setUploading}
          disabled={saving}
        />
      ) : (
        <p className="text-sm text-muted">
          File uploads aren&rsquo;t set up for your school yet. Paste the scheme of work
          or fill in the weeks below.
        </p>
      )}

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

      <div>
        <Button
          type="submit"
          full
          size="lg"
          disabled={saving || uploading || !classId || !effectiveSubject}
        >
          {saving ? "Saving…" : publish ? "Save and publish" : "Save as draft"}
        </Button>
        {uploading && (
          <p className="mt-2 text-center text-sm text-muted">
            To save: wait for the document to finish uploading.
          </p>
        )}
      </div>
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
