import { NextResponse } from "next/server";
import {
  getTutorSession,
  assertClassAccess,
  assertDocumentSubjectAccess,
} from "@/lib/auth/tutor";
import { getStudentSession } from "@/lib/auth/student";
import { getScheme } from "@/lib/db/schemes";
import { getFile } from "@/lib/storage/provider";

/**
 * Serve a scheme of work's original file. NEVER public: every request re-checks
 * authorization server-side, exactly like /api/lessons/[id]/file.
 *
 *  - Tutors/admins: same school, class access, and subject access.
 *  - Students:      same school, own class, and the scheme must be PUBLISHED.
 *
 * The R2 object key never leaves the server. It lives on the document and is
 * resolved here at read time; a key on a client payload would be a public bucket
 * URL by another name (CLAUDE.md, file storage).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const scheme = await getScheme(id);
  if (!scheme?.fileKey) {
    return NextResponse.json({ error: "No file for this scheme of work." }, { status: 404 });
  }

  const tutor = await getTutorSession();
  if (tutor) {
    if (scheme.schoolId !== tutor.schoolId) {
      return NextResponse.json({ error: "Scheme of work not found." }, { status: 404 });
    }
    try {
      assertClassAccess(tutor, scheme.classId);
      assertDocumentSubjectAccess(tutor, scheme);
    } catch {
      return NextResponse.json(
        { error: "You don't teach that class and subject." },
        { status: 403 }
      );
    }
  } else {
    const student = await getStudentSession();
    if (!student) {
      // A pasted link in a browser should land on sign-in, not raw JSON.
      if (req.headers.get("accept")?.includes("text/html")) {
        return NextResponse.redirect(new URL("/student/sign-in", req.url));
      }
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    }
    if (
      scheme.schoolId !== student.schoolId ||
      scheme.classId !== student.classId ||
      !scheme.publishedAt
    ) {
      // One message for all three refusals, so a guessed id cannot distinguish
      // "another class's scheme" from "a draft" from "does not exist".
      return NextResponse.json({ error: "Scheme of work not found." }, { status: 404 });
    }
  }

  const stored = await getFile(scheme.fileKey);
  if (!stored) {
    return NextResponse.json({ error: "The file is no longer available." }, { status: 404 });
  }

  const mime = scheme.fileType ?? stored.contentType ?? "application/octet-stream";
  const inline =
    mime.startsWith("application/pdf") || mime.startsWith("text/") || mime.startsWith("image/");
  const safeName = (scheme.fileName ?? "scheme-of-work").replace(/[^\w.\- ]+/g, "_");

  return new NextResponse(new Uint8Array(stored.body), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(stored.body.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      // Private: browsers may cache locally, shared caches must not.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
