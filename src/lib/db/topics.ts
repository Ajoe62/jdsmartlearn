import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import type { ClassLevel, Term, Topic } from "@/types";

/**
 * All topics for a school, ready for the "New lesson" pickers.
 * Single-field equality query with no orderBy - deliberately needs NO composite
 * index (see docs/firestore-indexes-to-append.md). Sorted in memory instead.
 */
export async function listTopics(schoolId: string): Promise<Topic[]> {
  const snap = await adminDb
    .collection(JD.topics)
    .where("schoolId", "==", schoolId)
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Topic)
    .sort((a, b) => a.position - b.position);
}

/**
 * A tutor-created topic for when the seeded curriculum has no match.
 * position is offset far past the seeded range (1..~99) so custom topics list
 * after curriculum ones, ordered by creation.
 */
export async function createCustomTopic(data: {
  schoolId: string;
  subjectId: string;
  level: ClassLevel;
  term: Term;
  title: string;
}): Promise<Topic> {
  assertWritable(JD.topics);
  const topic: Omit<Topic, "id"> = {
    ...data,
    position: 1000 + Math.floor(Date.now() / 1000) % 1_000_000,
    objectives: [],
    isCustom: true,
    createdAt: Date.now(),
  };
  const ref = await adminDb.collection(JD.topics).add(topic);
  return { id: ref.id, ...topic };
}
