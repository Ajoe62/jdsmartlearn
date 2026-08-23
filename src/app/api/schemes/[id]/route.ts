import { NextResponse } from "next/server";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { deleteScheme, getScheme, setSchemePublished } from "@/lib/db/schemes";
import { writeAuditLog } from "@/lib/db/lessons";
import { deleteFile } from "@/lib/storage/provider";

/**
 * Publish, withdraw, or delete one scheme of work.
 *
 * Authorization is re-checked here, not inherited from whatever page linked to
 * this. The (class, subject) pair must be one the tutor teaches, read fresh from
 * ResultPeak on this request.
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function authorize(id: string) {
  const session = await getTutorSession();
  if (!session) return { error: bad("Sign in to continue.", 401) } as const;

  const scheme = await getScheme(id);
  // Same message for "another school's" and "does not exist", so a guessed id
  // confirms nothing.
  if (!scheme || scheme.schoolId !== session.schoolId) {
    return { error: bad("Scheme of work not found.", 404) } as const;
  }

  try {
    assertClassAccess(session, scheme.classId);
    assertDocumentSubjectAccess(session, scheme);
  } catch {
    return { error: bad("You don't teach that class and subject.", 403) } as const;
  }

  return { session, scheme } as const;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await authorize(id);
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as { published?: boolean };
  if (typeof body.published !== "boolean") return bad("Say whether to publish it.");

  await setSchemePublished(id, auth.scheme.classId, body.published);

  await writeAuditLog({
    schoolId: auth.session.schoolId,
    actorUid: auth.session.uid,
    action: body.published ? "scheme_published" : "scheme_withdrawn",
    entityId: id,
  }).catch(() => {});

  return NextResponse.json({ ok: true, published: body.published });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await authorize(id);
  if ("error" in auth) return auth.error;

  /**
   * Delete the stored file FIRST, then the document.
   *
   * That order round: a failed file delete leaves an orphaned object in R2,
   * which costs a few kilobytes on a zero-egress free tier. The other order
   * would leave a document pointing at a file that is gone, which renders as a
   * broken download on a child's phone. Cheap litter beats a visible error.
   */
  if (auth.scheme.fileKey) {
    await deleteFile(auth.scheme.fileKey).catch(() => {});
  }
  await deleteScheme(id, auth.scheme.classId);

  await writeAuditLog({
    schoolId: auth.session.schoolId,
    actorUid: auth.session.uid,
    action: "scheme_deleted",
    entityId: id,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
