"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CONTROL } from "@/components/ui/Field";
import { STORE, del, get, put } from "@/lib/offline/db";
import type { StoredDraft } from "@/lib/offline/db";
import { queueSubmission } from "@/lib/offline/submissions";
import { formatBytes } from "@/lib/format";
import {
  MAX_SUBMISSION_FILES,
  extensionOf,
  rejectAttachment,
} from "@/lib/storage/file-types";
import { readApiError, uploadFile } from "@/lib/upload-client";
import type { StudentAssignment } from "@/types/student-dashboard";

/**
 * Write and hand in an answer.
 *
 * Two things matter more than anything else on this screen:
 *
 *  1. **The draft is never lost.** It saves to IndexedDB as they type, restores
 *     on mount, and survives a closed tab, a dead battery and a lost signal.
 *     IndexedDB rather than localStorage: localStorage is synchronous, and it
 *     would survive a different child signing in on a shared phone, which the
 *     existing wipe path is built to prevent.
 *  2. **Nothing is sent twice.** Submit disables in flight, and the server
 *     writes at a deterministic id so a replay reads as "already in".
 *
 * Files go straight from the phone to storage before the answer is sent, and a
 * camera photo is shrunk first. Files never enter IndexedDB (CLAUDE.md).
 */

const AUTOSAVE_MS = 800;
/** Long edge of a shrunk photo. Plenty for a teacher, or the marking model, to read handwriting. */
const PHOTO_EDGE = 1600;

export default function SubmissionForm({
  assignment,
  open,
  filesAvailable,
}: {
  assignment: StudentAssignment;
  open: boolean;
  filesAvailable: boolean;
}) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore the draft. Runs once; the textarea is empty until it lands, which is
  // the truthful state rather than a flash of nothing followed by a jump.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const draft = await get<StoredDraft>(STORE.drafts, assignment.assignmentId);
        if (alive && draft?.content) setContent(draft.content);
      } catch {
        // No device store. They type from scratch.
      }
    })();
    return () => {
      alive = false;
    };
  }, [assignment.assignmentId]);

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const saveDraft = useCallback(
    (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void put(STORE.drafts, {
          assignmentId: assignment.assignmentId,
          content: text,
          updatedAt: Date.now(),
        }).catch(() => undefined);
      }, AUTOSAVE_MS);
    },
    [assignment.assignmentId]
  );

  function onType(text: string) {
    setContent(text);
    saveDraft(text);
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    const picked = Array.from(list);
    const room = MAX_SUBMISSION_FILES - files.length;
    if (picked.length > room) {
      setError(`You can attach ${MAX_SUBMISSION_FILES} files in total.`);
      return;
    }
    /**
     * The same function the submit route enforces with, so a file the server
     * would refuse is caught before a child on 3G waits for the upload. This is
     * still only a courtesy: `accept` below is a hint that some browsers ignore,
     * and the server checks every file again regardless of what happened here.
     */
    const refused = picked
      .map((f) => rejectAttachment(f, assignment.allowedFileTypes))
      .find((message): message is string => message !== null);
    if (refused) {
      setError(refused);
      return;
    }
    setFiles((current) => [...current, ...picked]);
  }

  const hasWork = content.trim().length > 0 || files.length > 0;

  async function send() {
    setError(null);
    setBusy(true);
    setConfirming(false);

    /**
     * Offline with typed work: queue it. Offline with files: refuse, because a
     * multi-megabyte photo held in IndexedDB until reconnect blows the device
     * budget and puts an unmanaged copy of a child's work outside the wipe path.
     */
    if (!online) {
      if (files.length > 0) {
        setError(
          "You need internet to send a photo or file. Your typing is saved on this phone."
        );
        setBusy(false);
        return;
      }
      const queued = await queueSubmission(assignment.assignmentId, content.trim());
      if (!queued) {
        setError("This phone can't save work offline. Connect and send again.");
        setBusy(false);
        return;
      }
      router.push("/student/assignments?tab=submitted");
      router.refresh();
      return;
    }

    try {
      /**
       * Each file goes straight to storage first, then one small request hands
       * in the answer with the upload keys. The bytes never pass through our
       * server, whose platform refuses anything over 4.5 MB.
       */
      const ready: File[] = [];
      for (const file of files) ready.push(await shrinkPhoto(file));
      const total = ready.reduce((n, f) => n + f.size, 0);
      const attachments: { uploadKey: string; name: string }[] = [];
      let sent = 0;
      if (total > 0) setProgress(0);
      for (const file of ready) {
        const uploadKey = await uploadFile(file, "submission", {
          onProgress: (fraction) =>
            setProgress(Math.round(((sent + fraction * file.size) / total) * 100)),
        });
        sent += file.size;
        attachments.push({ uploadKey, name: file.name });
      }

      const res = await fetch("/api/student/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "submit",
          assignmentId: assignment.assignmentId,
          content: content.trim(),
          attachments,
        }),
      });
      if (!res.ok) throw new Error(await readApiError(res, "We couldn't send your work. Try again."));

      await del(STORE.drafts, assignment.assignmentId).catch(() => undefined);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "Your connection dropped. Try again."
          : err instanceof Error
            ? err.message
            : "We couldn't send your work."
      );
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/student/assignments" className="text-sm text-muted">
        Back to your work
      </Link>
      <h1 className="mt-3 text-title">{assignment.title}</h1>
      <p className="mt-1 text-sm text-muted">
        {assignment.subjectName} &middot; {assignment.maxMarks} marks &middot; Due{" "}
        {new Date(assignment.dueDate).toDateString()}
      </p>

      {assignment.description && (
        <p className="mt-4 whitespace-pre-wrap rounded-lg border border-line bg-surface p-4">
          {assignment.description}
        </p>
      )}

      {assignment.file && (
        <p className="mt-3 text-sm">
          <a
            href={`/api/assignments/${encodeURIComponent(assignment.assignmentId)}/file`}
            target={assignment.file.inline ? "_blank" : undefined}
            className="font-medium text-brand underline"
          >
            {assignment.file.inline ? "Open the question sheet" : "Download the question sheet"}
          </a>{" "}
          <span className="text-muted">({formatBytes(assignment.file.size)})</span>
        </p>
      )}

      {assignment.linkedLessonId && (
        <Link
          href={`/student/lessons/${assignment.linkedLessonId}`}
          className="mt-3 inline-block text-sm text-brand underline"
        >
          Read the lesson first
        </Link>
      )}

      {!open ? (
        <p className="mt-6 rounded-lg border border-line bg-surface p-4 text-muted">
          The time for this assignment has passed. Speak to your teacher.
        </p>
      ) : (
        <>
          {!online && (
            <p role="status" className="mt-6 rounded-lg border border-line bg-canvas p-4 text-sm">
              <span className="font-medium">You&rsquo;re offline.</span> Keep writing.
              Your answer is saved on your phone and sends when you have internet.
            </p>
          )}

          <label className="mt-6 block">
            <span className="text-sm font-medium">Your answer</span>
            <textarea
              value={content}
              onChange={(e) => onType(e.target.value)}
              rows={12}
              disabled={busy}
              className={CONTROL}
            />
            <span className="mt-1 block text-right text-xs text-muted">
              {content.length} characters
            </span>
          </label>

          {filesAvailable && (
            <div className="mt-4">
              <p className="text-sm font-medium">Add a photo or file</p>
              <p className="mt-1 text-sm text-muted">
                {online
                  ? `You can attach ${assignment.allowedFileTypes.join(", ")}.`
                  : "You need internet to attach a file."}
              </p>
              <input
                type="file"
                multiple
                accept={assignment.allowedFileTypes.join(",")}
                disabled={busy || !online}
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
                className="mt-2 block w-full text-sm disabled:opacity-60"
              />

              {files.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {files.map((file, i) => (
                    <li
                      key={`${file.name}-${i}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {file.name}
                        <span className="text-muted"> {formatBytes(file.size)}</span>
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setFiles((c) => c.filter((_, j) => j !== i))}
                        className="shrink-0 font-medium text-brand disabled:opacity-60"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {progress !== null && (
            <p role="status" className="mt-4 text-sm text-muted">
              Sending your work. {progress}%
            </p>
          )}

          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-line bg-canvas p-3 text-sm">
              {error}
            </p>
          )}

          {confirming ? (
            <div className="mt-6 rounded-lg border border-line bg-canvas p-4">
              <p className="font-medium">Once submitted you cannot edit this. Continue?</p>
              <div className="mt-3 flex gap-3">
                <Button onClick={() => void send()}>Confirm</Button>
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => setConfirming(true)}
              disabled={!hasWork || busy}
              size="lg"
              full
              className="mt-6"
            >
              {busy ? "Sending" : "Send to your teacher"}
            </Button>
          )}
        </>
      )}
    </main>
  );
}

/**
 * Shrink a camera photo before it leaves the phone.
 *
 * A modern phone photo is 3 to 8 MB. At 1600 px on the long side it is a few
 * hundred KB, reads just as well, and sends in a fraction of the time on 3G.
 * JPEG only: a PNG is usually a screenshot and already small, and converting it
 * would change a file type the teacher may not accept. Any failure sends the
 * original - shrinking is a courtesy, never a reason a child's work does not go.
 */
async function shrinkPhoto(file: File): Promise<File> {
  const ext = extensionOf(file.name);
  if ((ext !== ".jpg" && ext !== ".jpeg") || file.size < 700 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82)
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
