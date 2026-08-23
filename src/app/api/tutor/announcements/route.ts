import { NextResponse } from "next/server";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { createNotice, deleteNotice } from "@/lib/db/announcements";
import { writeAuditLog } from "@/lib/db/lessons";
import {
  NOTICE_CATEGORIES,
  type NoticeCategory,
  type NoticePriority,
  type NoticeReach,
} from "@/lib/announcements/notices";

/**
 * Post and withdraw school announcements.
 *
 * Authorization is server-side and unconditional. A school admin may address the
 * whole school or any class in it; a tutor may address only classes in their
 * `assignedClasses`, read fresh from ResultPeak on this request. The composer
 * hiding a class it should not offer is a convenience, not a control.
 *
 * NOTHING HERE TOUCHES THE AI PROVIDER. An announcement is a fact a school
 * states, and CLAUDE.md forbids generating one.
 */

const MAX_TITLE = 100;
const MAX_BODY = 600;

/**
 * How far ahead a notice may be scheduled, and how long it may run.
 *
 * A year, both ways. Not arbitrary: the bound is what stops a typo in a date
 * field ("2062") from parking a notice on four hundred phones until somebody
 * notices, or from writing one that has already silently expired.
 */
const MAX_SCHEDULE_MS = 365 * 24 * 60 * 60 * 1000;

const REACHES: NoticeReach[] = ["students", "tutors", "everyone"];
const PRIORITIES: NoticePriority[] = ["normal", "urgent"];

interface Body {
  audience?: string;
  classId?: string | null;
  reach?: string;
  category?: string;
  priority?: string;
  title?: string;
  body?: string;
  startsAt?: number | null;
  expiresAt?: number | null;
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const body = (await req.json().catch(() => ({}))) as Body;

  const title = body.title?.trim() ?? "";
  const text = body.body?.trim() ?? "";

  if (!title) return bad("Give your announcement a title.");
  if (title.length > MAX_TITLE) return bad(`Keep the title under ${MAX_TITLE} characters.`);
  if (!text) return bad("Write the announcement.");
  if (text.length > MAX_BODY) {
    return bad(
      `Keep the announcement under ${MAX_BODY} characters. Anything longer belongs in a lesson or a scheme of work.`
    );
  }

  const category = body.category as NoticeCategory;
  if (!NOTICE_CATEGORIES.includes(category)) return bad("Choose what kind of announcement this is.");

  const priority = body.priority as NoticePriority;
  if (!PRIORITIES.includes(priority)) return bad("Choose how urgent this is.");

  const reach = body.reach as NoticeReach;
  if (!REACHES.includes(reach)) return bad("Choose who should see this.");

  /**
   * Audience and the authorization that goes with it.
   *
   * A school-wide notice is an ADMIN-ONLY act, and the check is here rather than
   * in the composer: a tutor whose own class list is empty could otherwise reach
   * every child in the school with a request the interface never offered them.
   */
  const audience = body.audience === "school" ? "school" : "class";
  let targetId: string;

  if (audience === "school") {
    if (!session.isAdmin) {
      return bad(
        "Only a school admin can send an announcement to the whole school. Choose a class instead.",
        403
      );
    }
    targetId = session.schoolId;
  } else {
    const classId = body.classId?.trim() ?? "";
    if (!classId) return bad("Choose a class.");
    try {
      assertClassAccess(session, classId);
    } catch {
      return bad("You don't teach that class.", 403);
    }
    targetId = classId;
  }

  /**
   * The schedule. Absent means "now, until withdrawn", which is what most
   * notices are.
   *
   * `startsAt` in the past is allowed and normal - a school writing up this
   * morning's message at noon should not be argued with. `expiresAt` in the past
   * is not: it would create a notice nobody ever sees, and silently.
   */
  const now = Date.now();
  const startsAt = body.startsAt == null ? now : Number(body.startsAt);
  if (!Number.isFinite(startsAt)) return bad("Check the start date.");
  if (startsAt > now + MAX_SCHEDULE_MS) {
    return bad("That start date is more than a year away. Check it.");
  }

  let expiresAt: number | null = null;
  if (body.expiresAt != null) {
    expiresAt = Number(body.expiresAt);
    if (!Number.isFinite(expiresAt)) return bad("Check the date this should stop showing.");
    if (expiresAt <= startsAt) {
      return bad("The date it stops showing must be after the date it starts.");
    }
    if (expiresAt > now + MAX_SCHEDULE_MS) {
      return bad("That end date is more than a year away. Check it.");
    }
  }

  const id = await createNotice({
    schoolId: session.schoolId,
    audience,
    targetId,
    reach,
    category,
    priority,
    title,
    body: text,
    startsAt,
    expiresAt,
    createdBy: session.uid,
    // Falls back to a role rather than a uid. toNoticeItem() has its own
    // fallback for the same reason; both exist because a school admin has no
    // ResultPeak tutor profile and therefore no name.
    createdByName: session.name || (session.isAdmin ? "Your school" : "Your teacher"),
  });

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "announcement_created",
    entityId: id,
  }).catch(() => {
    // An announcement that reached its readers must not fail on its audit row.
  });

  return NextResponse.json({ id }, { status: 201 });
}

/**
 * Withdraw an announcement.
 *
 * Deletes rather than flags - see deleteNotice(). Every refusal is checked in
 * that function and every one of them looks the same from here: another school's
 * notice, another tutor's, or one that never existed all answer 404, so this
 * route confirms nothing about announcements the caller may not touch.
 */
export async function DELETE(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return bad("Which announcement?");

  const removed = await deleteNotice(session.schoolId, id, {
    uid: session.uid,
    isAdmin: session.isAdmin,
  });
  if (!removed) return bad("That announcement is no longer there.", 404);

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "announcement_withdrawn",
    entityId: id,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
