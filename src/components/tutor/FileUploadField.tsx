"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import Field, { CONTROL } from "@/components/ui/Field";
import { formatBytes } from "@/lib/format";
import {
  MAX_TUTOR_FILE_BYTES,
  TUTOR_UPLOAD_LABEL,
  TUTOR_UPLOAD_TYPES,
  acceptAttr,
  formatLimit,
  rejectTutorUpload,
  type UploadPurpose,
} from "@/lib/storage/file-types";
import { UploadCancelled, uploadFile } from "@/lib/upload-client";

/**
 * The one file picker every tutor form uses: lesson, scheme of work, and an
 * assignment's question sheet.
 *
 * UPLOADS AS SOON AS A FILE IS CHOSEN, not on Save. On 3G a large file takes
 * minutes; starting while the teacher fills in the rest of the form turns that
 * wait into time they were spending anyway. The parent form gets a staging key
 * through `onChange` and posts it with everything else, and `onBusyChange` lets
 * it hold Save until the upload lands.
 */

export interface UploadedFile {
  uploadKey: string;
  name: string;
  size: number;
}

export default function FileUploadField({
  id,
  label,
  hint,
  purpose,
  value,
  onChange,
  onBusyChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  purpose: Exclude<UploadPurpose, "submission">;
  value: UploadedFile | null;
  onChange: (file: UploadedFile | null) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [picked, setPicked] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Leaving the page mid-upload stops the upload rather than orphaning it.
  useEffect(() => () => inFlight.current?.abort(), []);

  async function start(file: File) {
    inFlight.current?.abort();
    setPicked(file);
    onChange(null);

    const refusal = rejectTutorUpload(file);
    setError(refusal);
    if (refusal) return;

    const controller = new AbortController();
    inFlight.current = controller;
    setProgress(0);
    onBusyChange?.(true);
    try {
      const uploadKey = await uploadFile(file, purpose, {
        onProgress: setProgress,
        signal: controller.signal,
      });
      onChange({ uploadKey, name: file.name, size: file.size });
    } catch (err) {
      if (!(err instanceof UploadCancelled)) {
        setError(err instanceof Error ? err.message : "The upload didn't finish. Try again.");
      }
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setProgress(null);
        onBusyChange?.(false);
      }
    }
  }

  function clear() {
    const controller = inFlight.current;
    inFlight.current = null;
    controller?.abort();
    if (controller) onBusyChange?.(false);
    setPicked(null);
    setProgress(null);
    setError(null);
    onChange(null);
  }

  const percent = progress === null ? 0 : Math.round(progress * 100);
  const retryable = picked !== null && error !== null && rejectTutorUpload(picked) === null;

  return (
    <Field
      label={label}
      hint={hint ?? `${TUTOR_UPLOAD_LABEL}, up to ${formatLimit(MAX_TUTOR_FILE_BYTES)}.`}
      htmlFor={id}
    >
      {value ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          <span className="min-w-0 truncate">
            <span className="font-medium">{value.name}</span>{" "}
            <span className="text-muted">({formatBytes(value.size)}) · Uploaded</span>
          </span>
          <Button variant="ghost" onClick={clear} disabled={disabled}>
            Remove
          </Button>
        </div>
      ) : progress !== null && picked ? (
        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">Uploading {picked.name}</span>
            <Button variant="ghost" onClick={clear}>
              Cancel
            </Button>
          </div>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-canvas"
            role="progressbar"
            aria-label={`Uploading ${picked.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">
            {percent}% of {formatBytes(picked.size)}. Keep this page open until it finishes.
          </p>
        </div>
      ) : (
        <input
          id={id}
          type="file"
          accept={acceptAttr(TUTOR_UPLOAD_TYPES)}
          disabled={disabled}
          className={CONTROL}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void start(file);
          }}
        />
      )}

      {error && (
        <div className="mt-2 space-y-2">
          <Callout tone="danger">{error}</Callout>
          {retryable && (
            <Button variant="secondary" onClick={() => void start(picked)}>
              Try again
            </Button>
          )}
        </div>
      )}
    </Field>
  );
}
