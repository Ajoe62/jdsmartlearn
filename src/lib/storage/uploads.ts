import "server-only";
import { randomBytes } from "node:crypto";
import type { TutorSession } from "@/lib/auth/tutor";
import type { StudentSession } from "@/lib/auth/student";
import { tryExtractText } from "@/lib/extract/text";
import {
  cleanFileName,
  extensionOf,
  formatLimit,
  maxBytesFor,
  uploadTypesFor,
  type UploadPurpose,
} from "./file-types";
import { ownsStagingKey, stagingKey } from "./keys";
import { STORABLE_TYPES, copyFile, deleteFile, getFile, statFile } from "./provider";

/**
 * Uploads, server half: hand out a staging address, then CLAIM what arrived.
 *
 * WHY IT IS SPLIT IN TWO. A Vercel function refuses any request body over
 * 4.5 MB, so a file cannot be posted to the route that creates a lesson. The
 * browser PUTs it straight to R2 on a presigned address under the staging
 * prefix (see keys.ts), then calls the normal route with the staging key. That
 * route - and only that route, after its own class and subject checks - claims
 * the upload with `claimUpload()`.
 *
 * THE CLAIM IS WHERE THE SERVER VOUCHES FOR THE BYTES. Everything the browser
 * said at `start` is re-checked against the object that actually landed: the
 * key must be this uploader's, the extension must be allowed for this purpose,
 * and the REAL size from R2 must be inside the cap. The type is set from
 * STORABLE_TYPES during the copy, never kept from the browser.
 */

export interface UploadActor {
  schoolId: string;
  /** Namespaced so a tutor uid and a student id can never share a folder. */
  actorId: string;
}

export function tutorActor(session: Pick<TutorSession, "schoolId" | "uid">): UploadActor {
  return { schoolId: session.schoolId, actorId: `t-${session.uid}` };
}

export function studentActor(
  session: Pick<StudentSession, "schoolId" | "studentId">
): UploadActor {
  return { schoolId: session.schoolId, actorId: `s-${session.studentId}` };
}

/** A refusal with a message for the person uploading and the status to send. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
  }
}

const AGAIN = "Choose the file and upload it again.";

/**
 * Validate what the browser says it is about to upload, before any address is
 * handed out. Returns the extension and the MIME type to sign the PUT with.
 * The claim checks the real object again - this only saves a pointless upload.
 */
export function checkUpload(
  purpose: UploadPurpose,
  fileName: unknown,
  size: unknown
): { ext: string; mime: string } {
  const name = typeof fileName === "string" && fileName ? fileName : "That file";
  const bytes = Number(size);
  const ext = extensionOf(name);
  const storable = STORABLE_TYPES[ext];
  if (!storable || !uploadTypesFor(purpose).includes(ext)) {
    throw new UploadError(`${name} can't be uploaded here. Choose a different type of file.`);
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new UploadError(`${name} is empty. Choose another file.`);
  }
  const max = maxBytesFor(purpose);
  if (bytes > max) throw new UploadError(`${name} is larger than ${formatLimit(max)}.`);
  return { ext, mime: storable.mime };
}

export function newStagingKey(actor: UploadActor, ext: string): string {
  return stagingKey(actor.schoolId, actor.actorId, randomBytes(16).toString("hex"), ext);
}

/** The staging key, if it is this actor's. Throws otherwise. */
export function assertOwnsUpload(actor: UploadActor, key: unknown): string {
  if (typeof key !== "string" || !ownsStagingKey(key, actor.schoolId, actor.actorId)) {
    throw new UploadError(`We couldn't find your upload. ${AGAIN}`, 403);
  }
  return key;
}

export interface ClaimedFile {
  /** The permanent key. */
  key: string;
  /** The uploader's file name, cleaned. For display and the download header. */
  name: string;
  /** Measured by R2, not reported by the browser. */
  size: number;
  /** From STORABLE_TYPES. */
  mime: string;
}

/**
 * Move a staged upload to its permanent key and return what was stored.
 *
 * Call it AFTER the route has authorized the request - the claim checks
 * ownership of the upload, not the right to attach it to a lesson.
 *
 * `finalKey` receives the extension, because the permanent key carries it
 * (keys.ts) and the extension is only known from the staged object.
 */
export async function claimUpload(
  actor: UploadActor,
  purpose: UploadPurpose,
  uploadKey: unknown,
  fileName: unknown,
  finalKey: (ext: string) => string
): Promise<ClaimedFile> {
  const key = assertOwnsUpload(actor, uploadKey);
  const ext = extensionOf(key);
  const storable = STORABLE_TYPES[ext];
  if (!storable || !uploadTypesFor(purpose).includes(ext)) {
    throw new UploadError("That type of file can't be uploaded here.");
  }

  const stat = await statFile(key);
  if (!stat) {
    throw new UploadError(`We couldn't find your upload. It may not have finished. ${AGAIN}`);
  }
  const max = maxBytesFor(purpose);
  if (stat.size === 0 || stat.size > max) {
    await deleteFile(key).catch(() => undefined);
    throw new UploadError(
      stat.size === 0
        ? "That file is empty. Choose another file."
        : `That file is larger than ${formatLimit(max)}.`
    );
  }

  const target = finalKey(ext);
  try {
    await copyFile(key, target, storable.mime);
  } catch (err) {
    console.error(`[uploads] claiming ${key} -> ${target} failed`, err);
    throw new UploadError("Storing the file failed. Check your connection and try again.", 502);
  }
  // The staging copy is litter now. The lifecycle rule catches it if this fails.
  await deleteFile(key).catch((err) => console.warn(`[uploads] removing ${key} failed`, err));

  return { key: target, name: cleanFileName(fileName, ext), size: stat.size, mime: storable.mime };
}

/** Best-effort text from a claimed file. "" when there is none worth keeping. */
export async function readClaimedText(file: ClaimedFile): Promise<string> {
  return tryExtractText(file.name, file.size, async () => (await getFile(file.key))?.body ?? null);
}

/** Undo a claim when the document that would point at it could not be written. */
export async function discardClaimed(file: ClaimedFile | null): Promise<void> {
  if (file) await deleteFile(file.key).catch(() => undefined);
}

/** The four fields every document with an original carries. */
export function fileFields(file: ClaimedFile) {
  return { fileKey: file.key, fileName: file.name, fileSize: file.size, fileType: file.mime };
}
