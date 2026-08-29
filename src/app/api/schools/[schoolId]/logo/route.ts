import { NextResponse } from "next/server";
import { getSchoolCrest } from "@/lib/branding/school";
import { CREST_TYPES } from "@/lib/branding/crest";

/**
 * A school's crest.
 *
 * THIS ROUTE IS DELIBERATELY UNAUTHENTICATED, AND IT IS THE ONE DOCUMENTED
 * EXCEPTION to "files are served only via an authenticated route, never a public
 * bucket URL" (CLAUDE.md). That rule protects lesson material and marking
 * guides. This cannot require a session, because the screen that needs the crest
 * most is the sign-in screen, where nobody has one yet - and a school's front
 * door showing a grey box until you log in defeats the entire point of the
 * feature.
 *
 * What the exception is bounded by:
 *
 *   - The URL names a SCHOOL and nothing else. There is no storage key anywhere
 *     in this path now: the bytes are decoded from the data URI on that school's
 *     own branding record, so there is no object store for a crafted path to
 *     reach into. This got strictly narrower when ResultPeak took ownership of
 *     the crest.
 *   - 404 for a school that is missing, inactive, or has no crest.
 *   - Content-Type comes from a server-side allowlist, never from the request
 *     and never from the stored object's own header.
 *   - Nothing here is personal data. A crest is what a school prints on a
 *     uniform and hangs on its gate. There is no enumeration worth having: you
 *     need a 20-character Firestore id to ask, and the answer is a public logo.
 *
 * SVG is served with a null CSP and nosniff because an SVG is a document that
 * can carry script, and the admin who forwarded their designer's file has not
 * audited it. In practice SVG cannot arrive any more - ResultPeak refuses it on
 * upload and isSafeCrestUrl refuses it on read - but the headers stay, because
 * the day they are removed is the day somebody widens the allowlist.
 *
 * WHY THIS ROUTE STILL EXISTS NOW THAT THE CREST IS A DATA URI ON A DOCUMENT
 * THIS REPO ALREADY READS. Because /api/student/sync ETags its whole response
 * body: an 81 KB base64 crest inside it would be re-downloaded by every child in
 * a class every time a tutor published a lesson. Serving it here instead keeps
 * a ~50 byte versioned URL in that payload, and the service worker already
 * caches this path. See getSchoolBrand().
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ schoolId: string }> }
) {
  const { schoolId } = await ctx.params;

  const crest = await getSchoolCrest(schoolId);
  if (!crest) {
    return NextResponse.json({ error: "No crest for this school." }, { status: 404 });
  }

  // The stored type was validated at upload, but re-check against the allowlist
  // rather than trusting a field: this decides what a browser will execute.
  if (!(CREST_TYPES as readonly string[]).includes(crest.contentType)) {
    return NextResponse.json({ error: "No crest for this school." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(crest.body), {
    headers: {
      "Content-Type": crest.contentType,
      "Content-Length": String(crest.body.length),
      /**
       * Immutable for a year, and freshness comes from `?v={logoUpdatedAt}` in
       * the URL getSchoolBrand builds. That field moves ONLY when the crest
       * bytes move, so a school fixing a typo in its motto does not bust every
       * cached crest, and a new crest is a new URL with nothing to invalidate.
       * `public` is correct and deliberate - this is the one response in the
       * product a shared cache may hold.
       */
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
