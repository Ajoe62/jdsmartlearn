import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "./collections";
import { assertWritable } from "./write-guard";

/**
 * Read receipts: one doc per (lesson, student), keyed deterministically so a
 * re-reading student UPDATES their doc instead of growing the collection.
 * Stores only the studentId reference - never a name (see CLAUDE.md, minors).
 */

export async function recordLessonView(view: {
  schoolId: string;
  classId: string;
  lessonId: string;
  studentId: string;
}): Promise<void> {
  assertWritable(JD.lessonViews);
  const id = `${view.lessonId}_${view.studentId}`;
  await adminDb.doc(`${JD.lessonViews}/${id}`).set(
    {
      ...view,
      viewCount: FieldValue.increment(1),
      lastViewedAt: Date.now(),
    },
    { merge: true }
  );
}

/**
 * Record a batch of receipts queued on a device while it had no network.
 *
 * `increment` is not idempotent, so a flush whose response was lost would
 * double-count on retry. Each receipt therefore carries the flush's batchId, and
 * a doc already stamped with that id is skipped. The read-check-write has to be
 * a transaction or two devices flushing at once could both skip or both apply.
 *
 * Bounded: the caller caps the batch, and every write is a single-doc merge on a
 * deterministic key, so this cannot fan out.
 */
export async function recordLessonViewBatch(input: {
  schoolId: string;
  classId: string;
  studentId: string;
  batchId: string;
  views: { lessonId: string; count: number }[];
}): Promise<{ applied: number; skipped: number }> {
  assertWritable(JD.lessonViews);

  let applied = 0;
  let skipped = 0;

  for (const v of input.views) {
    const ref = adminDb.doc(`${JD.lessonViews}/${v.lessonId}_${input.studentId}`);
    const changed = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { lastBatchId?: string }).lastBatchId === input.batchId) {
        return false; // Already applied - this is a retry.
      }
      tx.set(
        ref,
        {
          schoolId: input.schoolId,
          classId: input.classId,
          lessonId: v.lessonId,
          studentId: input.studentId,
          viewCount: FieldValue.increment(v.count),
          lastViewedAt: Date.now(),
          lastBatchId: input.batchId,
        },
        { merge: true }
      );
      return true;
    });
    if (changed) applied++;
    else skipped++;
  }

  return { applied, skipped };
}

/** How many distinct students have opened this lesson. Aggregate count - cheap. */
export async function countLessonReaders(
  lessonId: string,
  schoolId: string
): Promise<number> {
  const agg = await adminDb
    .collection(JD.lessonViews)
    .where("schoolId", "==", schoolId)
    .where("lessonId", "==", lessonId)
    .count()
    .get();
  return agg.data().count;
}
