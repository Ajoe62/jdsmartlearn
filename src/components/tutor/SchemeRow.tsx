"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import Badge from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatBytes } from "@/lib/format";
import { TUTOR_UPLOAD_TYPES, acceptAttr, rejectTutorUpload } from "@/lib/storage/file-types";
import { readApiError, uploadFile } from "@/lib/upload-client";

/**
 * One uploaded scheme of work: its file, its publish switch, and the controls
 * to replace or delete it.
 *
 * The FILE IS SHOWN AND OPENABLE HERE. It used to be invisible on the tutor's
 * side: a tutor who uploaded a scheme could not see what they had uploaded, and
 * a failed store looked exactly like a successful one.
 *
 * ONE publish switch, unlike a lesson's two. A lesson separates the raw material
 * from the AI study guide because the guide needs teacher review before a child
 * sees it. A scheme has no generated half, so a second switch would be a control
 * with nothing behind it.
 */
export default function SchemeRow({
  id,
  title,
  term,
  session,
  published,
  file,
}: {
  id: string;
  title: string;
  term: string | null;
  session: string | null;
  published: boolean;
  file: { name: string; size: number } | null;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState(published);
  const [busy, setBusy] = useState<false | "publish" | "delete">(false);
  /** Upload progress 0..1, or null when nothing is uploading. */
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/schemes/${encodeURIComponent(id)}`;
  const working = busy !== false || progress !== null;

  async function toggle() {
    setBusy("publish");
    setError(null);
    try {
      const res = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ published: !live }),
      });
      if (!res.ok) {
        setError(await readApiError(res, "We couldn't change that. Try again."));
        return;
      }
      setLive(!live);
      router.refresh();
    } catch {
      setError("We couldn't reach the internet. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  async function replace(picked: File) {
    setError(null);
    const refusal = rejectTutorUpload(picked);
    if (refusal) {
      setError(refusal);
      return;
    }
    setProgress(0);
    try {
      const uploadKey = await uploadFile(picked, "scheme", { onProgress: setProgress });
      const res = await fetch(`${base}/file/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ uploadKey, fileName: picked.name }),
      });
      if (!res.ok) throw new Error(await readApiError(res, "Storing the file failed. Try again."));
      router.refresh();
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "We couldn't reach the internet. Nothing was changed."
          : err instanceof Error
            ? err.message
            : "Storing the file failed. Try again."
      );
    } finally {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete "${title}"? Students will no longer see it, and its file is deleted too.`
      )
    ) {
      return;
    }
    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(base, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) {
        setError(await readApiError(res, "We couldn't delete that. Try again."));
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("We couldn't reach the internet. Nothing was deleted.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-sm text-muted">{termLabel(term, session)}</p>
          {file ? (
            <a
              href={`${base}/file`}
              target="_blank"
              className="mt-0.5 block truncate text-sm font-medium text-brand"
            >
              {file.name} <span className="font-normal text-muted">({formatBytes(file.size)})</span>
            </a>
          ) : (
            <p className="mt-0.5 text-sm text-muted">No file attached</p>
          )}
        </div>
        <Badge tone={live ? "success" : "neutral"}>{live ? "Students see it" : "Draft"}</Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void toggle()} disabled={working}>
          {busy === "publish" ? "Saving…" : live ? "Take down" : "Publish"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={acceptAttr(TUTOR_UPLOAD_TYPES)}
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void replace(picked);
          }}
        />
        <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={working}>
          {progress !== null
            ? `Uploading… ${Math.round(progress * 100)}%`
            : file
              ? "Replace file"
              : "Attach file"}
        </Button>
        <Button variant="danger" onClick={() => void remove()} disabled={working}>
          {busy === "delete" ? "Deleting…" : "Delete"}
        </Button>
      </div>

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Both strings or neither. "Second Term" alone spans every year the school has
 * run, and a scheme with no stamp says "Not filed under a term" rather than
 * being placed in a guess.
 */
function termLabel(term: string | null, session: string | null): string {
  if (term === null || session === null) return "Not filed under a term";
  return `${term}, ${session}`;
}
