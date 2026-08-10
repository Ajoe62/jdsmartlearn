/**
 * The tutor write queue: work done offline uploads itself on reconnect.
 *
 * Rules that matter:
 *
 *  - **Strictly sequential.** One request at a time, in queue order. Parallel
 *    uploads on a saturated 3G link make every one of them slower, and the shared
 *    Spark quota does not want a burst.
 *  - **Collapse before sending** (see collapse.ts). Four offline edits to one
 *    lesson become one request.
 *  - **Never silently drop work.** A 4xx is terminal and surfaces to the tutor
 *    with the server's own message and a discard action. A 5xx or network error is
 *    retried with backoff.
 *  - **Same routes as the online path.** Queued ops post to `/api/lessons/*`, so
 *    authorization, class checks and validation are identical. A queued op for a
 *    class the tutor no longer teaches is SUPPOSED to fail.
 *  - **Never auto-generate.** Generation costs the daily cap and review before
 *    publish is mandatory, so a flushed create lands as a draft and waits for the
 *    tutor. That is a product rule, not an oversight.
 */

import {
  collapse,
  describe,
  isLocalId,
  type CreateOp,
  type DeleteOp,
  type MarkOp,
  type MaterialOp,
  type OutboxOp,
  type PatchOp,
  type PublishOp,
  type QueuedOp,
} from "./collapse";
import { clearQueue, dequeue, enqueue, listQueued, updateQueued } from "./tutor-db";

export type FlushSummary = {
  uploaded: number;
  failed: number;
  kept: number;
};

type Listener = () => void;
const listeners = new Set<Listener>();
let flushing = false;

export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  for (const fn of listeners) fn();
}

export function newLocalId(): `local:${string}` {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `local:${rand}`;
}

/** Queue one op. Returns false when the device has no store to queue into. */
export async function queueOp(op: OutboxOp): Promise<boolean> {
  try {
    await enqueue({
      op,
      label: describe(op),
      state: "pending",
      attempts: 0,
      createdAt: Date.now(),
    });
    changed();
    return true;
  } catch {
    return false;
  }
}

export async function queued(): Promise<QueuedOp[]> {
  return listQueued();
}

export async function pending(): Promise<QueuedOp[]> {
  return (await listQueued()).filter((q) => q.state !== "failed");
}

export async function failed(): Promise<QueuedOp[]> {
  return (await listQueued()).filter((q) => q.state === "failed");
}

/** Throw away one failed op the tutor chose to abandon. */
export async function discard(id: number): Promise<void> {
  await dequeue(id).catch(() => {});
  changed();
}

export async function discardAll(): Promise<void> {
  await clearQueue().catch(() => {});
  changed();
}

/**
 * Send everything queued.
 *
 * Collapses first, rewrites the stored queue to the collapsed form, then walks it
 * one op at a time. Stops early on a retryable failure - if the link just died,
 * hammering the remaining ops wastes the tutor's data.
 */
export async function flushTutorOutbox(): Promise<FlushSummary> {
  if (flushing) return { uploaded: 0, failed: 0, kept: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { uploaded: 0, failed: 0, kept: 0 };
  }

  flushing = true;
  try {
    const rows = await listQueued();
    const live = rows.filter((r) => r.state !== "failed" && r.id !== undefined);
    if (live.length === 0) return { uploaded: 0, failed: 0, kept: 0 };

    // Collapse, then rewrite the queue so the tutor's pending list shows what will
    // actually be sent rather than every keystroke's worth of ops.
    const collapsed = collapse(live.map((r) => r.op));
    if (collapsed.length !== live.length) {
      for (const r of live) await dequeue(r.id!).catch(() => {});
      for (const op of collapsed) {
        await enqueue({
          op,
          label: describe(op),
          state: "pending",
          attempts: 0,
          createdAt: Date.now(),
        });
      }
      changed();
    }

    let uploaded = 0;
    let failedCount = 0;
    let kept = 0;

    for (const row of (await listQueued()).filter(
      (r) => r.state === "pending" && r.id !== undefined
    )) {
      await updateQueued({ ...row, state: "sending" });
      changed();

      const result = await send(row.op);

      if (result.kind === "ok") {
        await dequeue(row.id!).catch(() => {});
        uploaded++;
        changed();
        continue;
      }

      if (result.kind === "terminal") {
        // The server will never accept this. Keep it visible with its reason.
        await updateQueued({
          ...row,
          state: "failed",
          error: result.message,
          attempts: row.attempts + 1,
        });
        failedCount++;
        changed();
        continue;
      }

      // Retryable: put it back and stop. The next reconnect picks up here.
      await updateQueued({ ...row, state: "pending", attempts: row.attempts + 1 });
      kept++;
      changed();
      break;
    }

    return { uploaded, failed: failedCount, kept };
  } finally {
    flushing = false;
  }
}

type SendResult =
  | { kind: "ok" }
  | { kind: "terminal"; message: string }
  | { kind: "retry" };

async function send(op: OutboxOp): Promise<SendResult> {
  try {
    switch (op.kind) {
      case "create":
        return await sendCreate(op);
      case "patch":
        return await sendPatch(op);
      case "publish":
        return await sendPublish(op);
      case "material":
        return await sendMaterial(op);
      case "delete":
        return await sendDelete(op);
      case "mark":
        return await sendMark(op);
    }
  } catch {
    // Network died mid-request.
    return { kind: "retry" };
  }
}

/** 4xx is the server's final word; 5xx and transport errors are worth retrying. */
async function classify(res: Response): Promise<SendResult> {
  if (res.ok) return { kind: "ok" };
  if (res.status >= 400 && res.status < 500) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      kind: "terminal",
      message: body.error ?? "The server wouldn't accept this.",
    };
  }
  return { kind: "retry" };
}

async function sendCreate(op: CreateOp): Promise<SendResult> {
  // The same multipart route the online form posts to - identical validation.
  const form = new FormData();
  form.set("title", op.title);
  form.set("classId", op.classId);
  form.set("topicId", op.topicId);
  form.set("text", op.text);
  if (op.publishMaterial) form.set("publishMaterial", "true");

  const res = await fetch("/api/lessons", {
    method: "POST",
    body: form,
    credentials: "same-origin",
  });
  return classify(res);
}

async function sendPatch(op: PatchOp): Promise<SendResult> {
  const res = await fetch(`/api/lessons/${op.target}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      ...(op.title !== undefined ? { title: op.title } : {}),
      ...(op.text !== undefined ? { extractedText: op.text } : {}),
      ...(op.classId !== undefined ? { classId: op.classId } : {}),
      baseUpdatedAt: op.baseUpdatedAt,
    }),
  });
  return classify(res);
}

async function sendPublish(op: PublishOp): Promise<SendResult> {
  const res = await fetch(`/api/lessons/${op.target}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      ...(op.summary !== undefined ? { summary: op.summary } : {}),
      ...(op.questions ? { questions: op.questions } : {}),
      ...(op.markingGuide ? { markingGuide: op.markingGuide } : {}),
      baseUpdatedAt: op.baseUpdatedAt,
    }),
  });
  return classify(res);
}

async function sendMaterial(op: MaterialOp): Promise<SendResult> {
  // A local id here means the create was collapsed away or failed; either way
  // there is nothing to toggle.
  if (isLocalId(op.target)) return { kind: "ok" };

  const res = await fetch(`/api/lessons/${op.target}/material`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ publish: op.publish }),
  });
  return classify(res);
}

async function sendDelete(op: DeleteOp): Promise<SendResult> {
  if (isLocalId(op.target)) return { kind: "ok" };

  const res = await fetch(`/api/lessons/${op.target}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  // Already gone is success as far as the queue is concerned.
  if (res.status === 404) return { kind: "ok" };
  return classify(res);
}

/**
 * The same route the online review panel posts to, so the ownership check, the
 * class check, the score clamp and the 409 staleness guard are identical. A
 * queued mark for a class the tutor no longer teaches is SUPPOSED to fail.
 */
async function sendMark(op: MarkOp): Promise<SendResult> {
  const res = await fetch("/api/tutor/finalise-assignment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      submissionId: op.target,
      action: op.release ? "finalise" : "draft",
      teacherScore: op.teacherScore,
      teacherComment: op.teacherComment,
      baseUpdatedAt: op.baseUpdatedAt,
    }),
  });
  return classify(res);
}

/** Wire reconnect and visibility triggers. On-demand only - never an interval. */
export function watchTutorConnection(): () => void {
  const onOnline = () => void flushTutorOutbox();
  const onVisible = () => {
    if (document.visibilityState === "visible") void flushTutorOutbox();
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
