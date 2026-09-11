import "server-only";
import { extensionOf } from "./file-types";
import { STORABLE_TYPES, getFile, presignDownload, statFile } from "./provider";

/**
 * Send a stored file to someone the calling route has ALREADY authorized.
 *
 * Every file route (lesson, scheme, assignment sheet, submission attachment)
 * does its own school, class and subject checks, then ends here. There is no
 * way to reach this without passing one of them.
 *
 * TWO PATHS, split at 4 MB:
 *
 *  - Small files stream through the route exactly as they always have. That
 *    keeps "Save it for offline" and the service worker's same-origin file
 *    cache working unchanged for the common case.
 *  - Larger files get a 302 to a presigned R2 address that expires in ten
 *    minutes. A Vercel function refuses to send a response body over 4.5 MB,
 *    so streaming them would fail outright - and on 3G a 60 MB download
 *    outlasts the function's time limit even if it did not.
 *
 * The presigned address is not a public bucket URL. It names one object, is
 * minted per request only after the route's checks pass, and dies in minutes;
 * the redirect itself is `no-store` so a browser cannot replay it later.
 */

export const STREAM_MAX_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_URL_SECONDS = 10 * 60;

function contentDisposition(inline: boolean, name: string): string {
  // An ASCII fallback for old browsers, then the real name for everyone else.
  const ascii = name.replace(/[^\w.\- ]+/g, "_") || "file";
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function notFound(): Response {
  return Response.json({ error: "The file is no longer available." }, { status: 404 });
}

export async function serveStoredFile(opts: {
  key: string;
  /** The uploader's file name, as stored on the document. */
  name: string | null | undefined;
  /** Used when the document has no name: "lesson-file" becomes "lesson-file.pdf". */
  fallbackName: string;
  /** From the document when known, which saves a HEAD request. */
  size?: number | null;
  /** For the streamed path. The redirect is always `no-store`. */
  cacheControl: string;
}): Promise<Response> {
  // Type and disposition come from the key's extension via our own allowlist -
  // the key is server-chosen, so nothing the uploader said reaches these headers.
  const ext = extensionOf(opts.key);
  const known = STORABLE_TYPES[ext];
  const mime = known?.mime ?? "application/octet-stream";
  const disposition = contentDisposition(known?.inline ?? false, opts.name || `${opts.fallbackName}${ext}`);

  let size = opts.size ?? 0;
  if (!size) {
    const stat = await statFile(opts.key);
    if (!stat) return notFound();
    size = stat.size;
  }

  if (size > STREAM_MAX_BYTES) {
    const url = await presignDownload(opts.key, {
      expiresIn: DOWNLOAD_URL_SECONDS,
      contentType: mime,
      disposition,
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  const stored = await getFile(opts.key);
  if (!stored) return notFound();

  return new Response(new Uint8Array(stored.body), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(stored.body.length),
      "Content-Disposition": disposition,
      "Cache-Control": opts.cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
