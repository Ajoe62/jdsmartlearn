/**
 * Queue a mark written offline.
 *
 * A thin wrapper over the EXISTING tutor outbox, not a second queue. Marks go
 * through the same store, the same collapse pass, the same sequential flush,
 * the same 4xx-is-terminal rule and the same PendingUploads surface as lesson
 * work. There is one tutor write path and this joins it.
 *
 * The store may hold a mark and a comment: tutor-only content on the tutor's own
 * phone, namespaced by uid, wiped when a different tutor signs in and expiring
 * with the 5-day session. Queued work never outlives the authorization that
 * produced it (CLAUDE.md, Tutor offline).
 */

import { queueOp } from "./tutor-outbox";

export interface MarkInput {
  submissionId: string;
  action: "draft" | "finalise";
  teacherScore: number | null;
  teacherComment: string | null;
  baseUpdatedAt: number;
}

export async function queueMark(input: MarkInput): Promise<boolean> {
  return queueOp({
    kind: "mark",
    target: input.submissionId,
    release: input.action === "finalise",
    teacherScore: input.teacherScore,
    teacherComment: input.teacherComment,
    baseUpdatedAt: input.baseUpdatedAt,
  });
}
