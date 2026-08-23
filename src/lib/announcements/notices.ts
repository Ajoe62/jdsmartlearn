// Announcement visibility and read state. NO "server-only" here and nothing
// imported at all, deliberately: this decides which notices reach a child's
// phone and which of them still count as unread, and both are worth testing
// against the real function rather than a copy of it. Same treatment as
// src/lib/auth/subject-access.ts and src/lib/assessment/projection.ts, and
// covered by the same module-boundary guard in scripts/test-offline.ts - it must
// never grow an import of firebase-admin, a secret, or anything under src/lib/db.
//
// It holds no secret and reads no environment.

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * WHO the notice is addressed at, and therefore what `targetId` means.
 *
 *   school   targetId is the schoolId    - everyone in the school
 *   class    targetId is a classId       - one class
 *   tutor    targetId is a tutor's uid   - one member of staff
 *
 * `school` is the value added with announcements (2026-08-22). The other two
 * predate it and carry the class activity feed and tutor notifications, which is
 * why this collection is not called `announcements`: it was already here.
 */
export type NoticeAudience = "school" | "class" | "tutor";

/**
 * WHICH READERS inside that audience see it.
 *
 * Orthogonal to `audience`, and it has to be: "the whole school" and "the staff
 * of the whole school" are both real, and a school-wide notice about a staff
 * meeting must not reach four hundred children. A class-audience notice can be
 * staff-only too - that is how the assignment activity feed reaches a tutor
 * without telling the class an assignment exists before it is published.
 */
export type NoticeReach = "students" | "tutors" | "everyone";

/** What kind of school news this is. Drives the icon and the grouping, not access. */
export type NoticeCategory =
  | "resumption"
  | "exam"
  | "event"
  | "urgent"
  | "general";

export const NOTICE_CATEGORIES: NoticeCategory[] = [
  "resumption",
  "exam",
  "event",
  "urgent",
  "general",
];

/** Sentence case, plain nouns (CLAUDE.md, Interface writing). */
export const NOTICE_CATEGORY_LABELS: Record<NoticeCategory, string> = {
  resumption: "Resumption",
  exam: "Exams",
  event: "Event",
  urgent: "Urgent",
  general: "General",
};

/**
 * How loudly it renders. A TONE, NOT A DELIVERY MECHANISM (CLAUDE.md,
 * Announcement rules).
 *
 * An urgent notice is styled louder and sorts to the top. It does NOT arrive any
 * sooner: everything here rides the on-demand sync triggers, and there is no
 * push, no polling and no listener anywhere in this feature. If a school needs a
 * notice to outrun the next sync, that is a different product and needs its own
 * decision - do not quietly turn this field into one.
 */
export type NoticePriority = "normal" | "urgent";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * A `jdNotifications` document as Firestore actually holds it.
 *
 * EVERY FIELD ADDED FOR ANNOUNCEMENTS IS OPTIONAL, and that is not laziness.
 * This collection has been written since the assessment feature shipped and
 * already holds activity-feed rows with none of them. Making them required would
 * mean a backfill over a live school's data to add fields that have obvious,
 * correct defaults. `normaliseNotice()` below supplies those defaults in one
 * place; nothing else in the codebase may read a raw document.
 */
export interface StoredNotice {
  schoolId: string;
  audience: NoticeAudience;
  targetId: string;
  type: string;
  title: string;
  body: string;
  entityId: string;
  createdAt: number;

  reach?: NoticeReach;
  category?: NoticeCategory;
  priority?: NoticePriority;
  /** Visible from this moment. Lets a school write a resumption notice weeks early. */
  startsAt?: number;
  /** Retires itself. `null`/absent means it stays until deleted. */
  expiresAt?: number | null;
  /** Author uid. NEVER sent to a student - see toNoticeItem(). */
  createdBy?: string;
  /** Author's display name, denormalized at write time so a read costs no join. */
  createdByName?: string;
}

/** A notice with every field resolved. The only shape the rest of the code sees. */
export interface Notice {
  id: string;
  schoolId: string;
  audience: NoticeAudience;
  targetId: string;
  type: string;
  title: string;
  body: string;
  entityId: string;
  createdAt: number;
  reach: NoticeReach;
  category: NoticeCategory;
  priority: NoticePriority;
  startsAt: number;
  expiresAt: number | null;
  createdBy: string;
  createdByName: string;
}

/**
 * What travels to a device.
 *
 * Names its fields instead of spreading `Notice`, the same rule as
 * `toStudentPayload` and `toStudentAssignment`. `createdBy` (an author's uid) and
 * `schoolId` have no field here to occupy, so neither can reach a student's
 * phone by someone later adding a property upstream.
 */
export interface NoticeItem {
  id: string;
  title: string;
  body: string;
  category: NoticeCategory;
  priority: NoticePriority;
  from: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * What `reach` a pre-2026-08-22 document meant.
 *
 * Read this as a statement about the rows that already exist, not as a general
 * rule. A `tutor`-audience row was always staff-only. A `class`-audience row was
 * the class activity feed, which is student-facing. No `school` row can predate
 * the field, because the value did not exist, so its default never applies to
 * real data and is here only so the function is total.
 */
function defaultReach(audience: NoticeAudience): NoticeReach {
  if (audience === "tutor") return "tutors";
  if (audience === "class") return "students";
  return "everyone";
}

/**
 * Resolve a stored document into a complete `Notice`.
 *
 * THE ONLY PLACE a raw `jdNotifications` document is interpreted. Every default
 * lives here so a legacy row and a new one are indistinguishable everywhere
 * else, and so adding a field later means editing one function.
 *
 * `startsAt` defaults to `createdAt` rather than to 0: a notice with no schedule
 * is visible from the moment it was written, which is what "no schedule" means.
 */
export function normaliseNotice(id: string, raw: StoredNotice): Notice {
  return {
    id,
    schoolId: raw.schoolId,
    audience: raw.audience,
    targetId: raw.targetId,
    type: raw.type,
    title: raw.title,
    body: raw.body,
    entityId: raw.entityId,
    createdAt: raw.createdAt,
    reach: raw.reach ?? defaultReach(raw.audience),
    category: raw.category ?? "general",
    priority: raw.priority ?? "normal",
    startsAt: raw.startsAt ?? raw.createdAt,
    expiresAt: raw.expiresAt ?? null,
    createdBy: raw.createdBy ?? "",
    createdByName: raw.createdByName ?? "",
  };
}

/** The safe projection. Structurally cannot carry an author uid or a schoolId. */
export function toNoticeItem(n: Notice): NoticeItem {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    category: n.category,
    priority: n.priority,
    // Falls back to a role, never to a uid: a student must never be shown one,
    // and "From your school" is what a child understands anyway.
    from: n.createdByName || (n.audience === "school" ? "Your school" : "Your teacher"),
    createdAt: n.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Is this notice inside its own date window?
 *
 * Applied IN MEMORY, always. `startsAt <= now` and `expiresAt > now` are range
 * filters on two different fields, which Firestore refuses outright and which
 * would need a composite index even split apart - see
 * docs/firestore-indexes-to-append.md. The candidate set is tens of documents
 * per school, so filtering here is free.
 *
 * `expiresAt` is exclusive: a notice that expires at 09:00 is gone at 09:00.
 */
export function isLive(n: Notice, now: number): boolean {
  if (n.startsAt > now) return false;
  if (n.expiresAt !== null && n.expiresAt <= now) return false;
  return true;
}

export function reachesStudents(n: Notice): boolean {
  return n.reach === "students" || n.reach === "everyone";
}

export function reachesTutors(n: Notice): boolean {
  return n.reach === "tutors" || n.reach === "everyone";
}

/**
 * Which notices this student may see.
 *
 * The caller has already scoped the query to the school and to this student's
 * own class, so the audience test here is the second half of that check, not the
 * only one. Written positively - a notice must match a case to be included -
 * because a list of what to exclude is how a new audience value becomes visible
 * to everyone the day it is added.
 */
export function visibleToStudent(
  notices: Notice[],
  classId: string,
  now: number
): Notice[] {
  return sortNotices(
    notices.filter((n) => {
      if (!isLive(n, now)) return false;
      if (!reachesStudents(n)) return false;
      if (n.audience === "school") return true;
      if (n.audience === "class") return n.targetId === classId;
      return false; // `tutor` audience, and anything added later.
    })
  );
}

/** Which notices this tutor may see. Same positive-test rule as above. */
export function visibleToTutor(
  notices: Notice[],
  uid: string,
  classIds: string[],
  now: number
): Notice[] {
  return sortNotices(
    notices.filter((n) => {
      if (!isLive(n, now)) return false;
      if (!reachesTutors(n)) return false;
      if (n.audience === "school") return true;
      if (n.audience === "tutor") return n.targetId === uid;
      if (n.audience === "class") return classIds.includes(n.targetId);
      return false;
    })
  );
}

/**
 * Urgent first, then newest first.
 *
 * Sorted in memory over a `.limit()`ed result, like every other list in this
 * codebase: an `orderBy` beside the equality filters would need a composite
 * index in ResultPeak's project-level index file.
 *
 * GENERIC over anything with the two fields it reads, so the server sorting
 * `Notice[]` and the device sorting the `NoticeItem[]` projection call the same
 * function. A second copy of a two-line comparator is exactly the kind of thing
 * that drifts and then shows two people the same list in two different orders.
 */
export function sortNotices<T extends { priority: NoticePriority; createdAt: number }>(
  notices: T[]
): T[] {
  return [...notices].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "urgent" ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

/**
 * What one reader has already seen.
 *
 * ONE DOCUMENT PER READER, never one per reader per notice (CLAUDE.md,
 * Announcement rules). The obvious `{noticeId}_{studentId}` shape grows as
 * notices x students without bound, on a quota shared with a live school's exam
 * day; this grows as students, and each document stays small.
 *
 *   seenAt   a high-water mark. Everything created at or before it counts as
 *            read WITHOUT needing an id in the list.
 *   readIds  notices dismissed individually that `seenAt` does not yet cover.
 */
export interface ReadState {
  seenAt: number;
  readIds: string[];
}

/**
 * The only two fields read state cares about.
 *
 * Structural rather than `Notice`, so the device can pass its own stored row
 * straight in. A `StoredAnnouncement` satisfies this shape, and a `Notice` does
 * too - which means the badge on the phone and the badge rendered on the server
 * are computed by the same function over the same rule, not by two that agree
 * today.
 */
export interface NoticeRef {
  id: string;
  createdAt: number;
}

export const EMPTY_READ_STATE: ReadState = { seenAt: 0, readIds: [] };

/**
 * How many individually-dismissed ids one reader's document may hold.
 *
 * Bounds the document, which is read on every dashboard load. Fifty is far more
 * than a school posts in a term that is still live, and the compaction below
 * means the list is normally near-empty anyway.
 */
export const MAX_READ_IDS = 50;

/**
 * NOTE THAT `seenAt` IS NOT "WHEN THE STUDENT LAST LOOKED", and making it that
 * would delete the entire feature.
 *
 * The requirement is that a notice stays until the child dismisses it. If
 * opening the dashboard advanced the watermark to now, everything would be read
 * the instant it was displayed and nothing would ever stay. So the watermark
 * only ever advances to a point where EVERY notice at or below it has actually
 * been dismissed - see compact() below. Nothing else may write it.
 */
export function isUnread(n: NoticeRef, state: ReadState): boolean {
  if (n.createdAt <= state.seenAt) return false;
  return !state.readIds.includes(n.id);
}

export function unreadCount(notices: NoticeRef[], state: ReadState): number {
  return notices.reduce((total, n) => total + (isUnread(n, state) ? 1 : 0), 0);
}

/**
 * Fold newly dismissed ids into a reader's state, then compact it.
 *
 * `known` is the notice set the reader was actually looking at. It is required,
 * not optional: compaction has to know each id's `createdAt` to decide what the
 * watermark can safely swallow, and guessing would either resurrect a dismissed
 * notice or silently bury an undismissed one.
 *
 * Ids in `dismissed` that are not in `known` are kept as-is rather than dropped.
 * A device that has been offline for a week can dismiss a notice that has since
 * expired off the server's list, and losing that dismissal would make the notice
 * pop back up if it were ever un-expired.
 */
export function nextReadState(
  state: ReadState,
  known: NoticeRef[],
  dismissed: string[]
): ReadState {
  const merged = new Set(state.readIds);
  for (const id of dismissed) merged.add(id);
  return compact({ seenAt: state.seenAt, readIds: [...merged] }, known);
}

/**
 * Trade ids for watermark wherever that loses no information, then enforce the
 * cap.
 *
 * Two passes, and the order matters:
 *
 *  1. LOSSLESS. Walk the known notices oldest first and advance the watermark
 *     across every unbroken run of dismissed ones. The first notice still
 *     unread stops the walk - past that point the watermark cannot move without
 *     marking something read that nobody dismissed. Ids the watermark now covers
 *     are dropped from the list, because it says the same thing in one number.
 *
 *  2. LOSSY, AND ONLY IF STILL OVER THE CAP. Drop the oldest remaining ids and
 *     advance the watermark past them. This does mark some undismissed older
 *     notices as read, which is a real loss and is the reason it is second and
 *     conditional. It is bounded: it takes more than MAX_READ_IDS live notices,
 *     dismissed out of order, to reach it, and the alternative is an unbounded
 *     array in a document read on every dashboard load.
 */
function compact(state: ReadState, known: NoticeRef[]): ReadState {
  const byAge = [...known].sort((a, b) => a.createdAt - b.createdAt);
  const dismissed = new Set(state.readIds);

  let seenAt = state.seenAt;
  for (const n of byAge) {
    if (n.createdAt <= seenAt) continue;
    if (!dismissed.has(n.id)) break; // An unread notice. The watermark stops here.
    seenAt = n.createdAt;
  }

  const ageById = new Map(known.map((n) => [n.id, n.createdAt]));
  // An id we have no notice for keeps its dismissal (see nextReadState). It
  // sorts as newest so the lossy pass sheds ids we can actually reason about
  // first.
  const remaining = state.readIds.filter((id) => (ageById.get(id) ?? Infinity) > seenAt);

  if (remaining.length <= MAX_READ_IDS) return { seenAt, readIds: remaining };

  const oldestFirst = [...remaining].sort(
    (a, b) => (ageById.get(a) ?? Infinity) - (ageById.get(b) ?? Infinity)
  );
  const shed = oldestFirst.slice(0, oldestFirst.length - MAX_READ_IDS);
  const keep = new Set(oldestFirst.slice(oldestFirst.length - MAX_READ_IDS));

  for (const id of shed) {
    const age = ageById.get(id);
    if (age !== undefined && age > seenAt) seenAt = age;
  }

  return { seenAt, readIds: state.readIds.filter((id) => keep.has(id)) };
}
