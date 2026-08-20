"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CONTROL } from "@/components/ui/Field";

/**
 * Edit title + material after creation; admins can also move the lesson to a
 * different class. Edits to published content go live on save.
 */
export default function EditLessonSection({
  lessonId,
  initialTitle,
  initialText,
  initialClassId,
  hasStudyGuide,
  anythingPublished,
  classes,
}: {
  lessonId: string;
  initialTitle: string;
  initialText: string;
  initialClassId: string;
  hasStudyGuide: boolean;
  anythingPublished: boolean;
  /** Only provided for admins - presence of >1 option enables the class mover. */
  classes: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [text, setText] = useState(initialText);
  const [classId, setClassId] = useState(initialClassId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const canMoveClass = classes.length > 1;
  const movingClass = classId !== initialClassId;
  const editingText = text.trim() !== initialText.trim();

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/lessons/${lessonId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, extractedText: text, classId }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? "Couldn't save the changes. Try again.");
      return;
    }
    setSaved(true);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="mt-4">
        <button
          onClick={() => {
            setOpen(true);
            setSaved(false);
          }}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-muted"
        >
          Edit lesson
        </button>
        {saved && <span className="ml-3 text-sm text-successText">Saved.</span>}
      </div>
    );
  }

  return (
    <section className="mt-4 rounded-lg border border-line bg-surface p-4">
      <h2 className="font-semibold">Edit lesson</h2>

      <label className="mt-4 block">
        <span className="text-sm font-medium">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={CONTROL}
        />
      </label>

      {canMoveClass && (
        <label className="mt-4 block">
          <span className="text-sm font-medium">Class</span>
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className={CONTROL}
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {movingClass && anythingPublished && (
            <p className="mt-1 text-xs text-accentText">
              Students in the current class will lose access; the new class gains it.
            </p>
          )}
        </label>
      )}

      <label className="mt-4 block">
        <span className="text-sm font-medium">Material text</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className={`${CONTROL} text-sm leading-relaxed`}
        />
        {editingText && hasStudyGuide && (
          <p className="mt-1 text-xs text-accentText">
            The study guide was made from the old text — regenerate it after saving
            so they match.
          </p>
        )}
      </label>

      {error && (
        <p className="mt-3 rounded-lg bg-dangerSoft px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            setTitle(initialTitle);
            setText(initialText);
            setClassId(initialClassId);
            setError(null);
          }}
          disabled={busy}
          className="text-muted"
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
