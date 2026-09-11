import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getScheme, schemesTag, setSchemeFile, updateScheme } from "@/lib/db/schemes";
import { writeAuditLog } from "@/lib/db/lessons";
import { deleteFile, storageConfigured } from "@/lib/storage/provider";
import { schemeFileKey } from "@/lib/storage/keys";
import {
  UploadError,
  claimUpload,
  fileFields,
  readClaimedText,
  tutorActor,
} from "@/lib/storage/uploads";

export const maxDuration = 60;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Attach or replace the original document on an EXISTING scheme of work - the
 * mirror of /api/lessons/[id]/file/upload. Covers a scheme typed as weeks that
 * now has a document, a corrected document, and a scheme whose original upload
 * was lost before uploads went direct to storage.
 *
 * Takes a staging key, not a file. Text is only read in when the scheme has
 * none, so replacing a file never silently rewrites text the tutor typed.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const scheme = await getScheme(id);
  // Same message for "another school's" and "does not exist".
  if (!scheme || scheme.schoolId !== session.schoolId) {
    return bad("Scheme of work not found.", 404);
  }
  try {
    assertClassAccess(session, scheme.classId);
    assertDocumentSubjectAccess(session, scheme);
  } catch {
    return bad("You don't teach that class and subject.", 403);
  }

  if (!storageConfigured()) {
    return bad("File storage isn't set up yet. Ask your administrator.", 503);
  }

  const body = (await req.json().catch(() => null)) as
    | { uploadKey?: string; fileName?: string }
    | null;
  if (!body?.uploadKey) return bad("Choose a file to attach.");

  let claimed;
  try {
    claimed = await claimUpload(tutorActor(session), "scheme", body.uploadKey, body.fileName, (ext) =>
      schemeFileKey(session.schoolId, id, ext)
    );
  } catch (err) {
    if (err instanceof UploadError) return bad(err.message, err.status);
    throw err;
  }

  // A different extension lands at a different key; remove the old object.
  if (scheme.fileKey && scheme.fileKey !== claimed.key) {
    await deleteFile(scheme.fileKey).catch((err) =>
      console.error(`scheme ${id}: removing replaced file failed`, err)
    );
  }

  await setSchemeFile(id, fileFields(claimed));

  let textFound = scheme.extractedText.trim().length > 0;
  if (!textFound) {
    const text = await readClaimedText(claimed);
    if (text) {
      await updateScheme(id, scheme.classId, { extractedText: text });
      textFound = true;
    }
  }

  // Students read the file's name and size from the cached scheme list.
  revalidateTag(schemesTag(scheme.classId));

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: scheme.fileKey ? "scheme_file_replaced" : "scheme_file_attached",
    entityId: id,
  }).catch(() => {});

  return NextResponse.json({
    ok: true,
    fileName: claimed.name,
    fileSize: claimed.size,
    textFound,
  });
}
