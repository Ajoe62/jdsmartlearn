"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TUTOR_UPLOAD_TYPES, acceptAttr, rejectTutorUpload } from "@/lib/storage/file-types";
import { readApiError, uploadFile } from "@/lib/upload-client";

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
  /** Upload progress 0..1, or null when nothing is uploading. */
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function attachFile(picked: File) {
    setError(null);
    const refusal = rejectTutorUpload(picked);
    if (refusal) {
      setError(refusal);
      return;
    }
    setProgress(0);
    try {
      // Straight to storage first, then one small request to attach it.
      const uploadKey = await uploadFile(picked, "lesson", { onProgress: setProgress });
      const res = await fetch(`/api/lessons/${lessonId}/file/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadKey, fileName: picked.name }),
      });
      if (!res.ok) throw new Error(await readApiError(res, "Storing the file failed. Try again."));
      router.refresh();
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "We couldn't reach the server. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "Storing the file failed. Try again."
      );
    } finally {
      setProgress(null);
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
      if (!res.ok) throw new Error(await readApiError(res, "We couldn't update the material."));
      setPublished(!published);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't update the material.");
    } finally {
      setBusy(false);
    }
  }

  const hasText = materialText.trim().length > 0;

  return (
    <section className="mt-6 rounded-lg border border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="font-medium">Lesson material</h2>
          <p className="mt-0.5 text-xs text-muted">
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
              ? "shrink-0 rounded-lg border border-line px-3 py-2 text-sm font-medium text-muted disabled:opacity-50"
              : "shrink-0 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brandHover disabled:opacity-50"
          }
        >
          {busy ? "Saving…" : published ? "Hide from students" : "Publish material"}
        </button>
      </div>

      {error && <p className="px-4 pt-3 text-sm text-danger" role="alert">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
        {file ? (
          <a
            href={`/api/lessons/${lessonId}/file`}
            target="_blank"
            className="min-w-0 truncate text-sm font-medium text-brand"
          >
            {file.name} <span className="font-normal text-muted">({file.sizeLabel})</span>
          </a>
        ) : (
          <span className="text-sm text-muted">
            No original file attached — students see the text below.
          </span>
        )}
        <input
          ref={fileInput}
          type="file"
          accept={acceptAttr(TUTOR_UPLOAD_TYPES)}
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void attachFile(picked);
          }}
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={progress !== null}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-muted disabled:opacity-50"
        >
          {progress !== null
            ? `Uploading… ${Math.round(progress * 100)}%`
            : file
              ? "Replace file"
              : "Attach file"}
        </button>
      </div>

      {hasText ? (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-muted">
          {materialText}
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-muted">
          No lesson text yet.{" "}
          {file
            ? "Students will open the file above once you publish the material. "
            : ""}
          Add the text under Edit lesson to make a study guide.
        </p>
      )}
    </section>
  );
}
