/**
 * Browser half of file uploads, shared by every form that takes a file.
 *
 * Bytes go from the phone STRAIGHT TO FILE STORAGE on short-lived signed
 * addresses the server hands out (/api/uploads). They never pass through our
 * own server, whose platform refuses any request over 4.5 MB - which is what
 * broke every upload above that size before this existed.
 *
 * Built for a bad 3G link:
 *  - Files over 8 MB go in 8 MB parts, sequentially, so a dropped connection
 *    costs one part, not the whole file.
 *  - Each PUT is retried with backoff on a network error or a 5xx.
 *  - Progress is real (XHR upload events), because a teacher watching a bar
 *    that does not move will close the tab.
 *
 * Returns the staging key. The caller then posts it to the route that creates
 * the lesson, scheme, assignment or submission, which CLAIMS it after its own
 * checks. An unclaimed upload is deleted by the bucket after a day.
 *
 * Imported by the student submission form, so keep it small and dependency free.
 */

import type { UploadPurpose } from "@/lib/storage/file-types";
import { partRange } from "@/lib/storage/upload-plan";

export class UploadFailed extends Error {}
/** The person cancelled. Not an error to show them. */
export class UploadCancelled extends UploadFailed {}

type Started =
  | { uploadKey: string; mode: "single"; url: string; contentType: string }
  | { uploadKey: string; mode: "multipart"; uploadId: string; partCount: number };

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * The message to show for a failed API response. The server's own words when it
 * sent any; otherwise plain wording for the platform errors that arrive as HTML.
 */
export async function readApiError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (data?.error) return data.error;
  if (res.status === 401) return "You've been signed out. Sign in again, then try once more.";
  if (res.status === 413) return "That was too large to send. Reload the page and try again.";
  if (res.status === 504) return "That took too long. Check your connection and try again.";
  return fallback;
}

function connectionMessage(): string {
  return typeof navigator !== "undefined" && navigator.onLine === false
    ? "You're offline. Connect to the internet and try again."
    : "We couldn't reach the server. Check your connection and try again.";
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    throw new UploadFailed(connectionMessage());
  }
  if (!res.ok) throw new UploadFailed(await readApiError(res, "The upload didn't start. Try again."));
  return (await res.json()) as T;
}

/** A failed PUT to storage. `status` 0 means the request never completed. */
class PutError extends Error {
  constructor(readonly status: number) {
    super(`PUT failed with ${status}`);
  }
}

function put(
  url: string,
  body: Blob,
  contentType: string | null,
  onSent: (bytes: number) => void,
  signal?: AbortSignal
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadCancelled("Upload cancelled."));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    // Must match the type the address was signed for, or storage refuses it.
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader("ETag"));
      else reject(new PutError(xhr.status));
    };
    xhr.onerror = () => reject(new PutError(0));
    xhr.ontimeout = () => reject(new PutError(0));
    xhr.onabort = () => reject(new UploadCancelled("Upload cancelled."));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

function retryable(err: unknown): boolean {
  if (!(err instanceof PutError)) return false;
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new UploadCancelled("Upload cancelled."));
      },
      { once: true }
    );
  });
}

async function withRetry<T>(attempt: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof UploadFailed) throw err;
      if (!retryable(err) || i >= RETRY_DELAYS_MS.length) {
        if (err instanceof PutError && err.status !== 0) {
          throw new UploadFailed(
            "File storage refused the upload. Try again. If it keeps happening, tell your school administrator."
          );
        }
        throw new UploadFailed(connectionMessage());
      }
      await wait(RETRY_DELAYS_MS[i], signal);
    }
  }
}

/**
 * Upload one file to staging and return its key.
 *
 * `onProgress` receives a fraction from 0 to 1. Throws `UploadFailed` with a
 * message fit to show, or `UploadCancelled` when `signal` aborts.
 */
export async function uploadFile(
  file: File,
  purpose: UploadPurpose,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<string> {
  const { onProgress, signal } = opts;
  const report = (sent: number) => onProgress?.(Math.min(1, sent / Math.max(1, file.size)));

  const started = await call<Started>({
    action: "start",
    purpose,
    fileName: file.name,
    size: file.size,
  });

  if (started.mode === "single") {
    await withRetry(() => put(started.url, file, started.contentType, report, signal), signal);
    report(file.size);
    return started.uploadKey;
  }

  const { uploadKey, uploadId } = started;
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (let partNumber = 1; partNumber <= started.partCount; partNumber++) {
      const { start, end } = partRange(file.size, partNumber);
      const blob = file.slice(start, end);
      const etag = await withRetry(async () => {
        // Signed per attempt, so a retry an hour later still has a live address.
        const { url } = await call<{ url: string }>({
          action: "sign-part",
          purpose,
          uploadKey,
          uploadId,
          partNumber,
        });
        return put(url, blob, null, (sent) => report(start + sent), signal);
      }, signal);
      if (!etag) {
        // Storage accepted the part but hid its receipt: the bucket's CORS rule
        // does not expose ETag. Only an administrator can fix that.
        throw new UploadFailed(
          "File storage isn't set up for large files yet. Tell your school administrator."
        );
      }
      parts.push({ partNumber, etag });
    }
    await call({ action: "complete", purpose, uploadKey, uploadId, parts });
  } catch (err) {
    void call({ action: "abort", purpose, uploadKey, uploadId }).catch(() => undefined);
    throw err;
  }
  report(file.size);
  return uploadKey;
}
