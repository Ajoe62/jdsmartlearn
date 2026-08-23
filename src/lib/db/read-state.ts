import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "./collections";
import { assertWritable } from "./write-guard";
import {
  EMPTY_READ_STATE,
  nextReadState,
  type Notice,
  type ReadState,
} from "@/lib/announcements/notices";

/**
 * What one reader has already seen.
 *
 * ONE DOCUMENT PER READER, at a deterministic id, never one per reader per
 * notice (CLAUDE.md, Announcement rules). Reading it is one `get()`; recording a
 * dismissal is one `set(..., { merge: true })`. No query, no transaction, no
 * index.
 *
 * NOT CACHED, and it must not be. Every other student read in this codebase goes
 * through `unstable_cache` because it is the same content for a whole class;
 * this is the one piece of state that differs per reader, and a cached copy
 * would either bleed one child's dismissals into another's dashboard or make a
 * dismissal take a revalidate window to stick. It costs one document read on a
 * screen that already reads several.
 */

export function readStateId(schoolId: string, readerId: string): string {
  return `${schoolId}_${readerId}`;
}

interface StoredReadState {
  schoolId: string;
  readerId: string;
  kind: "student" | "tutor";
  seenAt: number;
  readIds: string[];
  updatedAt: number;
}

/**
 * A reader who has never dismissed anything gets EMPTY_READ_STATE rather than
 * null, so the caller has no absent case to handle and cannot accidentally treat
 * "no document" as "everything read".
 *
 * A first-time reader therefore sees every currently live notice as unread,
 * which is correct - they have not read them - and is bounded by NOTICE_LIMIT
 * and by each notice's own expiry.
 */
export async function getReadState(
  schoolId: string,
  readerId: string
): Promise<ReadState> {
  const snap = await adminDb
    .doc(`${JD.readState}/${readStateId(schoolId, readerId)}`)
    .get();
  if (!snap.exists) return EMPTY_READ_STATE;

  const data = snap.data() as Partial<StoredReadState>;
  return {
    seenAt: typeof data.seenAt === "number" ? data.seenAt : 0,
    readIds: Array.isArray(data.readIds) ? data.readIds : [],
  };
}

/**
 * Record that a reader dismissed some notices.
 *
 * Reads the current state first rather than using `arrayUnion`, because
 * compaction needs the whole list and each notice's age to decide what the
 * watermark can safely swallow - see nextReadState(). Two operations on one
 * small document, on a screen the reader is already looking at.
 *
 * A lost race between two devices loses at most a dismissal, which the reader
 * fixes by tapping again. Deliberately not a transaction: a contended
 * transaction on a shared Spark quota is a worse failure than a notice that
 * needs dismissing twice on the rare occasion a child uses two phones at once.
 *
 * `known` is the notice set the reader was looking at, passed by the caller so
 * this function never has to query for it.
 */
export async function recordRead(
  schoolId: string,
  readerId: string,
  kind: "student" | "tutor",
  known: Notice[],
  dismissed: string[]
): Promise<ReadState> {
  assertWritable(JD.readState);

  const current = await getReadState(schoolId, readerId);
  const next = nextReadState(current, known, dismissed);

  // Nothing moved - a repeat tap, or a dismissal already covered by the
  // watermark. Skip the write rather than spend a quota on a no-op.
  if (next.seenAt === current.seenAt && next.readIds.length === current.readIds.length) {
    const same = next.readIds.every((id) => current.readIds.includes(id));
    if (same) return current;
  }

  const doc: StoredReadState = {
    schoolId,
    readerId,
    kind,
    seenAt: next.seenAt,
    readIds: next.readIds,
    updatedAt: Date.now(),
  };

  await adminDb
    .doc(`${JD.readState}/${readStateId(schoolId, readerId)}`)
    .set(doc, { merge: true });

  return next;
}

/**
 * Forget a reader's dismissals entirely.
 *
 * For the student sign-out path on a SHARED PHONE: the device store is wiped so
 * the next child sees nothing of the last one, and leaving a server-side read
 * state keyed to the previous student is harmless but pointless. Not called on
 * every sign-out today; kept because the shared-phone case is the normal case in
 * these schools and the alternative is discovering later that it was needed.
 */
export async function clearReadState(
  schoolId: string,
  readerId: string
): Promise<void> {
  assertWritable(JD.readState);
  await adminDb.doc(`${JD.readState}/${readStateId(schoolId, readerId)}`).delete();
}
