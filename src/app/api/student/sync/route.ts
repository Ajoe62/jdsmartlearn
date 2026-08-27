import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getSchoolBrand } from "@/lib/branding/school";
import { getClassSyncIndex } from "@/lib/db/student-content";
import { getNoticesForClass } from "@/lib/db/announcements";
import { getReadState } from "@/lib/db/read-state";
import { toNoticeItem, visibleToStudent } from "@/lib/announcements/notices";
import { listPublishedSchemesForClass, toSchemeSummary } from "@/lib/db/schemes";

/**
 * How long a device may keep reading saved lessons after this sync. Read here,
 * server-side, and sent to the device rather than exposed as a NEXT_PUBLIC_ var.
 * Capped at 30 days: a window longer than the refresh cookie's life would let a
 * device outlive any possibility of revocation.
 */
function offlineGraceDays(): number {
  const raw = Number(process.env.STUDENT_OFFLINE_GRACE_DAYS ?? 7);
  if (!Number.isFinite(raw) || raw < 0) return 7;
  return Math.min(raw, 30);
}

/**
 * The sync index: every lesson this student's class may read, without the
 * study-guide bodies, plus the announcements addressed to them.
 *
 * ~150 bytes per lesson, so ~30 KB at the 200-lesson cap - one small response
 * that completes on a bad link.
 *
 * ANNOUNCEMENTS RIDE THIS RESPONSE RATHER THAN GETTING AN ENDPOINT OF THEIR OWN.
 * That is the whole delivery mechanism: the student app already syncs on app
 * open, on reconnect, on an explicit button and on a one-shot Background Sync
 * tag, and adding a second thing to fetch on those triggers costs one array in a
 * response that is already being made. A notices endpoint would be polled, and
 * polling is forbidden (CLAUDE.md, Quota rules and Announcement rules).
 *
 * COST. The lesson index and the notice bundles are all `unstable_cache`d per
 * class, so a class of thirty shares them. The ONE uncached Firestore read here
 * is `getReadState` - it is per reader by definition, and caching it would
 * either bleed one child's dismissals into another's screen or make a dismissal
 * take a revalidate window to stick. One document read per sync per student is
 * the price of a notice that stays read across a re-sign-in on a shared phone,
 * and that is the behaviour worth paying for.
 *
 * ETag'd, so the common case (nothing published or posted since yesterday, and
 * nothing newly dismissed) is a 304.
 */
export async function GET(req: Request) {
  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const [lessons, noticeCandidates, readState, schemes, brand] = await Promise.all([
    getClassSyncIndex(session.schoolId, session.classId),
    getNoticesForClass(session.schoolId, session.classId),
    getReadState(session.schoolId, session.studentId),
    listPublishedSchemesForClass(session.schoolId, session.classId),
    /**
     * School branding rides this response for exactly the reason announcements
     * do: the device already syncs on app open, on reconnect, on an explicit
     * button and on a one-shot Background Sync tag, and a branding endpoint
     * would be polled. Polling is forbidden (CLAUDE.md, Quota rules).
     *
     * NOT folded into getClassSyncBundle, deliberately. That cache is keyed per
     * CLASS and tagged to lesson publishes; branding is per SCHOOL and changes
     * on a different event entirely. Putting it there would store the same crest
     * once per class and make every crest edit invalidate every class's lesson
     * index. getSchoolBrand is already cached per school, so this adds no
     * Firestore read in the common case and never fans out.
     */
    getSchoolBrand(session.schoolId),
  ]);

  // The date window and the reach test are applied here, in memory, over the
  // cached candidate set - see isLive() for why they cannot be query filters.
  const visible = visibleToStudent(noticeCandidates, session.classId, Date.now());

  const body = {
    studentId: session.studentId,
    classId: session.classId,
    graceDays: offlineGraceDays(),
    lessons,
    // The safe projection. Structurally cannot carry an author uid or a schoolId.
    announcements: visible.map(toNoticeItem),
    /**
     * Scheme-of-work SUMMARIES, so the subject shelf can count them offline.
     * Bodies are fetched per scheme when a child opens one - a dozen full
     * curriculum documents would not fit in one response on a 3G link.
     */
    schemes: schemes.map(toSchemeSummary),
    /**
     * Sent so the device can compute "unread" itself and render the badge with
     * no network. The device never DECIDES read state - it posts dismissals to
     * /api/student/announcements/read and takes back whatever the server says.
     */
    readState,
    /**
     * Null for a school we cannot resolve, which the device renders as the plain
     * product lockup - the same fallback every other surface uses.
     *
     * A PROJECTION, not the server object: no slug, no motto, and above all no
     * storage key. The crest is a URL to our own route.
     */
    brand: brand
      ? {
          schoolId: brand.schoolId,
          name: brand.name,
          shortName: brand.shortName,
          initials: brand.initials,
          crestUrl: brand.crestUrl,
          bg: brand.colour.bg,
          fg: brand.colour.fg,
          quiet: brand.colour.quiet,
        }
      : null,
  };

  // Hash the payload, not the request - the device only needs to know whether
  // anything it would store has changed.
  const json = JSON.stringify(body);
  const etag = `"${createHash("sha1").update(json).digest("base64url")}"`;

  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, no-store" },
    });
  }

  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      // The device store is IndexedDB, not the HTTP cache. Never let a shared
      // proxy hold a class's lesson list.
      "Cache-Control": "private, no-store",
    },
  });
}
