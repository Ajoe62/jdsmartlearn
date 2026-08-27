import { NextResponse } from "next/server";
import { getSchoolCrest } from "@/lib/branding/school";
import { CREST_TYPES } from "@/lib/branding/crest";
import { getFile } from "@/lib/storage/provider";

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
 *   - The URL names a SCHOOL, never a storage key. The key is read server-side
 *     from that school's own branding record, so this can never be pointed at
 *     another object in the bucket. An arbitrary key in the path is how a route
 *     like this becomes a read primitive for everything we store.
 *   - 404 for a school that is missing, inactive, or has no crest.
 *   - Content-Type comes from a server-side allowlist, never from the request
 *     and never from the stored object's own header.
 *   - Nothing here is personal data. A crest is what a school prints on a
 *     uniform and hangs on its gate. There is no enumeration worth having: you
 *     need a 20-character Firestore id to ask, and the answer is a public logo.
 *
 * SVG is served with a null CSP and nosniff because an SVG is a document that
 * can carry script, and the admin who forwarded their designer's file has not
 * audited it. See lib/branding/crest.
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

  const stored = await getFile(crest.key);
  if (!stored) {
    return NextResponse.json({ error: "No crest for this school." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(stored.body), {
    headers: {
      "Content-Type": crest.contentType,
      "Content-Length": String(stored.body.length),
      /**
       * Immutable for a year, and freshness comes from `?v={logoUpdatedAt}` in
       * the URL getSchoolBrand builds. A re-upload is a new URL, so there is
       * nothing to invalidate. `public` is correct and deliberate - this is the
       * one response in the product a shared cache may hold.
       */
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
