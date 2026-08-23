import "server-only";
import { unstable_cache, revalidateTag } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD, NOTICE_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import {
  normaliseNotice,
  sortNotices,
  type Notice,
  type NoticeCategory,
  type NoticePriority,
  type NoticeReach,
  type StoredNotice,
} from "@/lib/announcements/notices";

/**
 * School announcements, read and written.
 *
 * THE QUOTA MECHANISM IS THE SAME ONE THE LESSON SYNC USES: everything a class
 * may see is fetched by ONE cached function, shared by every student in that
 * class and by every route that needs it. Thirty children opening the app at 8am
 * cost two Firestore queries between them, not sixty.
 *
 * Nothing here polls, listens, or subscribes. Announcements ride the on-demand
 * sync triggers the student app already has (CLAUDE.md, Announcement rules).
 */

export const schoolNoticesTag = (schoolId: string) => `notices:${schoolId}`;
export const classNoticesTag = (classId: string) => `notices-class:${classId}`;
export const tutorNoticesTag = (uid: string) => `notices-tutor:${uid}`;

/**
 * Shorter than the lesson bundle's 300s.
 *
 * A published lesson is not urgent; a notice saying today's closing time has
 * changed is exactly the thing a school will complain took too long to appear.
 * Sixty seconds is the compromise: a class of forty still costs two queries a
 * minute at worst, and only while somebody is actually using the app.
 */
const REVALIDATE_SECONDS = 60;

/**
 * Every notice addressed at the whole school.
 *
 * Two equality filters, no orderBy, sorted in memory. `startsAt`/`expiresAt` are
 * NOT filtered here - see isLive() in lib/announcements/notices.ts for why that
 * would need a composite index in ResultPeak's project-level index file.
 */
const schoolNotices = (schoolId: string) =>
  unstable_cache(
    async (): Promise<Notice[]> => {
      const snap = await adminDb
        .collection(JD.notifications)
        .where("schoolId", "==", schoolId)
        .where("audience", "==", "school")
        .limit(NOTICE_LIMIT)
        .get();
      return sortNotices(
        snap.docs.map((d) => normaliseNotice(d.id, d.data() as StoredNotice))
      );
    },
    ["notices-school", schoolId],
    { tags: [schoolNoticesTag(schoolId)], revalidate: REVALIDATE_SECONDS }
  )();

/**
 * Every notice addressed at one class.
 *
 * Scoping is enforced INSIDE the cache and both ids are in the key, so a bundle
 * can never be served to another class or school - the same rule as
 * getClassSyncBundle.
 */
const classNotices = (schoolId: string, classId: string) =>
  unstable_cache(
    async (): Promise<Notice[]> => {
      const snap = await adminDb
        .collection(JD.notifications)
        .where("schoolId", "==", schoolId)
        .where("audience", "==", "class")
        .where("targetId", "==", classId)
        .limit(NOTICE_LIMIT)
        .get();
      return sortNotices(
        snap.docs.map((d) => normaliseNotice(d.id, d.data() as StoredNotice))
      );
    },
    ["notices-class", schoolId, classId],
    { tags: [classNoticesTag(classId)], revalidate: REVALIDATE_SECONDS }
  )();

/**
 * THE read for a student: school-wide plus their own class, in two cached
 * queries.
 *
 * Deliberately not one query with `array-contains` over an audience-key array.
 * That shape reads better and needs a composite index, which means a pull
 * request against ResultPeak's project-level index file and a deploy against a
 * live paying school's project before a single child could see a notice. See
 * docs/firestore-indexes-to-append.md.
 *
 * Returns the raw candidate set. The caller filters it for reach and date window
 * through visibleToStudent(), which is pure and tested.
 */
export async function getNoticesForClass(
  schoolId: string,
  classId: string
): Promise<Notice[]> {
  const [school, klass] = await Promise.all([
    schoolNotices(schoolId),
    classNotices(schoolId, classId),
  ]);
  return sortNotices([...school, ...klass]);
}

/** Notices addressed at one member of staff by uid. */
const tutorNotices = (schoolId: string, uid: string) =>
  unstable_cache(
    async (): Promise<Notice[]> => {
      const snap = await adminDb
        .collection(JD.notifications)
        .where("schoolId", "==", schoolId)
        .where("audience", "==", "tutor")
        .where("targetId", "==", uid)
        .limit(NOTICE_LIMIT)
        .get();
      return sortNotices(
        snap.docs.map((d) => normaliseNotice(d.id, d.data() as StoredNotice))
      );
    },
    ["notices-tutor", schoolId, uid],
    { tags: [tutorNoticesTag(uid)], revalidate: REVALIDATE_SECONDS }
  )();

/**
 * THE read for a tutor: school-wide plus anything addressed to them personally.
 *
 * DELIBERATELY DOES NOT FAN OUT OVER `assignedClasses`. A tutor with eight
 * classes would cost eight more queries on every dashboard load, and the class
 * feed is a student-facing surface - a tutor who wants to see what a class was
 * told opens that class. If this ever needs to include class notices, cache them
 * per class (they already are) and read only the classes actually on screen.
 */
export async function getNoticesForTutor(
  schoolId: string,
  uid: string
): Promise<Notice[]> {
  const [school, mine] = await Promise.all([
    schoolNotices(schoolId),
    tutorNotices(schoolId, uid),
  ]);
  return sortNotices([...school, ...mine]);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface NewNotice {
  schoolId: string;
  audience: "school" | "class";
  /** schoolId for a school-wide notice, classId for a class one. */
  targetId: string;
  reach: NoticeReach;
  category: NoticeCategory;
  priority: NoticePriority;
  title: string;
  body: string;
  startsAt: number;
  expiresAt: number | null;
  createdBy: string;
  createdByName: string;
}

/**
 * Post an announcement.
 *
 * ONE DOCUMENT, however many children read it. A per-student write would cost a
 * class of forty forty writes for one notice, on a quota shared with a live
 * school's exam day - and it is the reason an announcement may not contain
 * anything specific to one reader.
 *
 * Authorization happens in the route, not here: the class must be in the tutor's
 * `assignedClasses`, read fresh from ResultPeak on that request.
 *
 * `type: "announcement"` distinguishes these from the activity-feed rows the
 * assessment feature writes into the same collection.
 */
export async function createNotice(input: NewNotice): Promise<string> {
  assertWritable(JD.notifications);

  const doc: StoredNotice = {
    schoolId: input.schoolId,
    audience: input.audience,
    targetId: input.targetId,
    type: "announcement",
    title: input.title,
    body: input.body,
    // Points at itself. The field exists so a feed row can link to the
    // assignment that caused it; an announcement is its own subject.
    entityId: "",
    createdAt: Date.now(),
    reach: input.reach,
    category: input.category,
    priority: input.priority,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
    createdByName: input.createdByName,
  };

  const ref = await adminDb.collection(JD.notifications).add(doc);
  invalidate(input.audience, input.targetId, input.schoolId);
  return ref.id;
}

/**
 * Withdraw an announcement.
 *
 * DELETES rather than setting a flag. A notice a school has taken back should
 * stop existing: a soft-deleted row still occupies the query limit, still has to
 * be filtered on every read, and is one missed condition away from reappearing
 * on four hundred phones. Devices drop it on the next sync because it is simply
 * absent from the bundle.
 *
 * WHO MAY WITHDRAW: the author, or any school admin. Deliberately NOT anyone in
 * the school. `schoolId` scoping alone would let any tutor retract the school
 * office's resumption notice, which is not a permission anyone meant to grant
 * and would be invisible until a parent complained.
 *
 * Returns false for every refusal - missing, another school's, another tutor's,
 * or not an announcement at all - so the route answers 404 uniformly and leaks
 * nothing about which it was.
 */
export async function deleteNotice(
  schoolId: string,
  noticeId: string,
  actor: { uid: string; isAdmin: boolean }
): Promise<boolean> {
  assertWritable(JD.notifications);
  const ref = adminDb.doc(`${JD.notifications}/${noticeId}`);
  const snap = await ref.get();
  if (!snap.exists) return false;

  const notice = normaliseNotice(snap.id, snap.data() as StoredNotice);
  if (notice.schoolId !== schoolId) return false;
  // Only announcements. An activity-feed row is a record of something that
  // happened and is not a school's to retract.
  if (notice.type !== "announcement") return false;
  if (!actor.isAdmin && notice.createdBy !== actor.uid) return false;

  await ref.delete();
  invalidate(notice.audience, notice.targetId, notice.schoolId);
  return true;
}

/**
 * Drop the cached bundles a write touched.
 *
 * Without this a notice would take up to REVALIDATE_SECONDS to appear, which is
 * survivable, and a withdrawn one would take just as long to disappear, which is
 * not: the reason a school withdraws a notice is that it was wrong.
 */
function invalidate(audience: string, targetId: string, schoolId: string): void {
  if (audience === "school") revalidateTag(schoolNoticesTag(schoolId));
  else if (audience === "class") revalidateTag(classNoticesTag(targetId));
  else if (audience === "tutor") revalidateTag(tutorNoticesTag(targetId));
}

/**
 * Announcements this author has posted, for the composer's own list.
 *
 * Two equality filters, sorted in memory. Scoped to the author rather than the
 * school on purpose: a school admin's list of "notices I sent" is a manageable
 * screen, and "every notice anyone ever sent" is not a screen anybody asked for.
 */
export async function listNoticesByAuthor(
  schoolId: string,
  uid: string
): Promise<Notice[]> {
  const snap = await adminDb
    .collection(JD.notifications)
    .where("schoolId", "==", schoolId)
    .where("createdBy", "==", uid)
    .limit(NOTICE_LIMIT)
    .get();
  return sortNotices(
    snap.docs
      .map((d) => normaliseNotice(d.id, d.data() as StoredNotice))
      .filter((n) => n.type === "announcement")
  );
}
