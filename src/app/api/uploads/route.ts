import { NextResponse } from "next/server";
import { getTutorSession } from "@/lib/auth/tutor";
import { getStudentSession } from "@/lib/auth/student";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  presignUpload,
  presignUploadPart,
  startMultipartUpload,
  storageConfigured,
} from "@/lib/storage/provider";
import {
  UploadError,
  assertOwnsUpload,
  checkUpload,
  newStagingKey,
  studentActor,
  tutorActor,
  type UploadActor,
} from "@/lib/storage/uploads";
import { MAX_PARTS, partCount, usesMultipart } from "@/lib/storage/upload-plan";
import type { UploadPurpose } from "@/lib/storage/file-types";

/**
 * Hand out presigned addresses so a browser can put a file straight into R2.
 *
 *   action=start      check type and size, return a staging key and either one
 *                     PUT address (small files) or a multipart upload id
 *   action=sign-part  one PUT address for one part of a multipart upload
 *   action=complete   stitch the parts together
 *   action=abort      give up on a multipart upload
 *
 * NOTHING HERE ATTACHES A FILE TO ANYTHING. An upload is inert litter under the
 * staging prefix until a lesson, scheme, assignment or submission route claims
 * it, after that route's own authorization (storage/uploads.ts). So this route
 * only needs to know who is uploading: a tutor for their own originals, a
 * student for their own attachments. Every action re-checks that the staging
 * key belongs to the caller.
 */

const PURPOSES: readonly UploadPurpose[] = ["lesson", "scheme", "assignment", "submission"];
/** Long enough for one 8 MB part on a bad link; the claim re-checks everything anyway. */
const URL_SECONDS = 60 * 60;

interface Body {
  action?: string;
  purpose?: UploadPurpose;
  fileName?: string;
  size?: number;
  uploadKey?: string;
  uploadId?: string;
  partNumber?: number;
  parts?: { partNumber?: number; etag?: string }[];
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Students may only attach work; tutors may only upload originals. */
async function actorFor(purpose: UploadPurpose): Promise<UploadActor | null> {
  if (purpose === "submission") {
    const student = await getStudentSession();
    return student ? studentActor(student) : null;
  }
  const tutor = await getTutorSession();
  return tutor ? tutorActor(tutor) : null;
}

function uploadIdOf(body: Body): string {
  const id = body.uploadId;
  if (typeof id !== "string" || id.length === 0 || id.length > 1024) {
    throw new UploadError("We lost track of that upload. Choose the file and upload it again.");
  }
  return id;
}

export async function POST(req: Request) {
  if (!storageConfigured()) {
    return bad("File uploads aren't set up yet. Ask your administrator.", 503);
  }

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return bad("We couldn't read that request.");
  const purpose = body.purpose;
  if (!purpose || !PURPOSES.includes(purpose)) return bad("Unknown upload.");

  const actor = await actorFor(purpose);
  if (!actor) return bad("Sign in to continue.", 401);

  try {
    switch (body.action) {
      case "start": {
        const { ext, mime } = checkUpload(purpose, body.fileName, body.size);
        const uploadKey = newStagingKey(actor, ext);
        const size = Number(body.size);

        if (!usesMultipart(size)) {
          const url = await presignUpload(uploadKey, mime, URL_SECONDS);
          return NextResponse.json({ uploadKey, mode: "single", url, contentType: mime });
        }
        const uploadId = await startMultipartUpload(uploadKey, mime);
        return NextResponse.json({
          uploadKey,
          mode: "multipart",
          uploadId,
          partCount: partCount(size),
        });
      }

      case "sign-part": {
        const uploadKey = assertOwnsUpload(actor, body.uploadKey);
        const uploadId = uploadIdOf(body);
        const partNumber = Number(body.partNumber);
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
          return bad("That part of the upload is out of range.");
        }
        const url = await presignUploadPart(uploadKey, uploadId, partNumber, URL_SECONDS);
        return NextResponse.json({ url });
      }

      case "complete": {
        const uploadKey = assertOwnsUpload(actor, body.uploadKey);
        const uploadId = uploadIdOf(body);
        const raw = Array.isArray(body.parts) ? body.parts : [];
        if (raw.length === 0 || raw.length > MAX_PARTS) {
          return bad("That upload has no parts. Choose the file and upload it again.");
        }
        const parts = raw.map((p) => ({
          partNumber: Number(p?.partNumber),
          etag: typeof p?.etag === "string" ? p.etag : "",
        }));
        if (parts.some((p) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || !p.etag || p.etag.length > 200)) {
          return bad("Part of that upload went missing. Choose the file and upload it again.");
        }
        parts.sort((a, b) => a.partNumber - b.partNumber);
        await completeMultipartUpload(uploadKey, uploadId, parts);
        return NextResponse.json({ ok: true });
      }

      case "abort": {
        const uploadKey = assertOwnsUpload(actor, body.uploadKey);
        const uploadId = uploadIdOf(body);
        // Best effort. The lifecycle rule clears abandoned parts regardless.
        await abortMultipartUpload(uploadKey, uploadId).catch(() => undefined);
        return NextResponse.json({ ok: true });
      }

      default:
        return bad("Unknown action.");
    }
  } catch (err) {
    if (err instanceof UploadError) return bad(err.message, err.status);
    console.error(`[uploads] ${body.action} failed`, err);
    return bad("File storage didn't respond. Try again in a moment.", 502);
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
