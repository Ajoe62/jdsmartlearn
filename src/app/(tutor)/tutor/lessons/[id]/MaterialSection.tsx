"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The raw lesson material with its own publish switch - independent of the study
 * guide. A tutor can share the material straight after uploading, before any AI
 * generation.
 */
export default function MaterialSection({
  lessonId,
  materialText,
  initialPublished,
  file,
}: {
  lessonId: string;
  materialText: string;
  initialPublished: boolean;
  file: { name: string; sizeLabel: string } | null;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [published, setPublished] = useState(initialPublished);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function attachFile(picked: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", picked);
      const res = await fetch(`/api/lessons/${lessonId}/file/upload`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Storing the file failed. Try again.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Storing the file failed. Try again.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lessons/${lessonId}/material`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish: !published }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't update the material.");
      setPublished(!published);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't update the material.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-medium">Lesson material</h2>
          <p className="mt-0.5 text-xs text-slate">
            {published
              ? "Published — students in this class can read it."
              : "Only you can see this. Publish it to share it with students."}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={
            published
              ? "shrink-0 rounded-lg border border-line px-3 py-2 text-sm font-medium text-slate disabled:opacity-50"
              : "shrink-0 rounded-lg bg-marker px-3 py-2 text-sm font-medium text-chalk hover:bg-markerDark disabled:opacity-50"
          }
        >
          {busy ? "Saving…" : published ? "Hide from students" : "Publish material"}
        </button>
      </div>

      {error && <p className="px-4 pt-3 text-sm text-flag">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        {file ? (
          <a
            href={`/api/lessons/${lessonId}/file`}
            target="_blank"
            className="text-sm font-medium text-marker"
          >
            {file.name} <span className="font-normal text-slate">({file.sizeLabel})</span>
          </a>
        ) : (
          <span className="text-sm text-slate">
            No original file attached — students see the text below.
          </span>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,.txt"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void attachFile(picked);
          }}
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-slate disabled:opacity-50"
        >
          {uploading ? "Uploading…" : file ? "Replace file" : "Attach file"}
        </button>
      </div>

      <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-slate">
        {materialText}
      </div>
    </section>
  );
}
