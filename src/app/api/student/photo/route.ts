import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getOwnStudentPhoto } from "@/lib/db/student-photo";

/**
 * The signed-in student's own passport photo. Nobody else's, ever.
 *
 * The photo is ResultPeak's, approved by the school there; this route decodes
 * it from `studentPhotos/{id}` and sends bytes. It is NOT an exception to the
 * authenticated-files rule the way the crest route is - it is the rule. A crest
 * is on the school gate; a child's face is not (CLAUDE.md, Student photo rules).
 *
 * `?s=` must match the session's student. It exists so that each child's photo
 * is a different cache key on a shared phone (see studentPhotoUrl), and it can
 * only narrow what is served: a mismatch is a 404, never a different child.
 *
 * `?v=` is the photoUpdatedAt the URL was built from. It is not checked against
 * the current value: a phone asking with an old version gets the current photo
 * and the next sync hands it the new URL. That is harmless because the response
 * is never stored anywhere a stale key could keep it - see Cache-Control below.
 *
 * One 404 for every refusal - no photo, not yours, deactivated - so the answer
 * says nothing about which it was.
 */
export async function GET(req: Request) {
  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const asked = new URL(req.url).searchParams.get("s");
  if (asked !== null && asked !== session.studentId) return notFound();

  const photo = await getOwnStudentPhoto(session);
  if (!photo) return notFound();

  return new NextResponse(new Uint8Array(photo.body), {
    headers: {
      // Fixed, never taken from the stored string. decodeJpegDataUri has
      // already refused anything whose bytes are not a JPEG.
      "Content-Type": "image/jpeg",
      "Content-Length": String(photo.body.length),
      /**
       * NOT the crest's `public, immutable`. The browser's HTTP cache is a copy
       * no wipe in this product can reach: sign-out, a different child signing
       * in and the grace window all clear IndexedDB and the Cache API, and none
       * of them clear the HTTP cache. A child's face must not outlive the
       * session that fetched it on a shared phone.
       *
       * The one saved copy is the service worker's PHOTO_CACHE bucket, which
       * every wipe deletes by name. Cache.put ignores this header, so offline
       * still works.
       */
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

function notFound() {
  return NextResponse.json(
    { error: "No photo yet." },
    { status: 404, headers: { "Cache-Control": "private, no-store" } }
  );
}
