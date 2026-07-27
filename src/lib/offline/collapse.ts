/**
 * Pure collapsing logic for the tutor outbox.
 *
 * This file is why the tutor queue needs no dependency graph.
 *
 * The plan for offline tutors assumed queued edits would have to be rewritten
 * against a lesson id that did not exist server-side yet - a create/patch
 * dependency chain with blocked-dependent bookkeeping. Collapsing removes the
 * problem instead of managing it:
 *
 *   create + patch          -> one create carrying the final values
 *   create + publishMaterial-> one create with publishMaterial set
 *   create + delete         -> nothing at all
 *   patch  + patch          -> one patch, last write wins per field
 *   anything + delete       -> just the delete
 *
 * A `publish` can never follow an offline `create`, because generation sits
 * between them and generation is online-only. So after collapsing, every
 * remaining op either creates a lesson (self-contained) or targets an id the
 * server already knows. No chaining, no id rewriting.
 */

/** Local id for a lesson that exists only on this device so far. */
export type LocalId = `local:${string}`;

export function isLocalId(id: string): id is LocalId {
  return id.startsWith("local:");
}

export type CreateOp = {
  kind: "create";
  /** Always a local id - the server assigns the real one on flush. */
  target: LocalId;
  title: string;
  classId: string;
  topicId: string;
  text: string;
  /** Publish the raw material as soon as it lands. Folded in from a material op. */
  publishMaterial?: boolean;
};

export type PatchOp = {
  kind: "patch";
  target: string;
  title?: string;
  text?: string;
  classId?: string;
  /** The lesson's updatedAt when the tutor started editing - staleness guard. */
  baseUpdatedAt: number;
};

export type MaterialOp = {
  kind: "material";
  target: string;
  publish: boolean;
};

export type PublishOp = {
  kind: "publish";
  /** Requires generated content, so this is never a local id. */
  target: string;
  summary?: string;
  questions?: { number: number; question: string }[];
  markingGuide?: { number: number; keyPoints: string[] }[];
  baseUpdatedAt: number;
};

export type DeleteOp = {
  kind: "delete";
  target: string;
};

export type OutboxOp = CreateOp | PatchOp | MaterialOp | PublishOp | DeleteOp;

/** An op as stored, with its queue bookkeeping. */
export type QueuedOp = {
  id?: number;
  op: OutboxOp;
  /** A short human label, so the interface never has to name the system. */
  label: string;
  state: "pending" | "sending" | "failed";
  /** Server message for a terminal failure, shown to the tutor verbatim. */
  error?: string;
  attempts: number;
  createdAt: number;
};

/**
 * Reduce a queue to the fewest requests that produce the same result.
 *
 * Order is preserved by first appearance of each target, so what the tutor did
 * first still uploads first. Within a target the LAST value wins, which matches
 * what they last saw on screen.
 */
export function collapse(ops: OutboxOp[]): OutboxOp[] {
  // One accumulator per target, in first-seen order.
  const order: string[] = [];
  const byTarget = new Map<string, OutboxOp[]>();

  for (const op of ops) {
    if (!byTarget.has(op.target)) {
      byTarget.set(op.target, []);
      order.push(op.target);
    }
    byTarget.get(op.target)!.push(op);
  }

  const out: OutboxOp[] = [];
  for (const target of order) {
    out.push(...collapseTarget(byTarget.get(target)!));
  }
  return out;
}

function collapseTarget(ops: OutboxOp[]): OutboxOp[] {
  const create = ops.find((o): o is CreateOp => o.kind === "create");
  const deleted = ops.some((o) => o.kind === "delete");

  // Created and deleted while offline: it never existed anywhere else. Send nothing.
  if (create && deleted) return [];

  // Deleting a server lesson makes every earlier edit to it moot.
  if (deleted) {
    const target = ops[0].target;
    return [{ kind: "delete", target }];
  }

  if (create) {
    // Fold the follow-ups into the create itself.
    let merged: CreateOp = { ...create };
    for (const op of ops) {
      if (op.kind === "patch") {
        merged = {
          ...merged,
          ...(op.title !== undefined ? { title: op.title } : {}),
          ...(op.text !== undefined ? { text: op.text } : {}),
          ...(op.classId !== undefined ? { classId: op.classId } : {}),
        };
      } else if (op.kind === "material") {
        merged = { ...merged, publishMaterial: op.publish };
      }
      // A publish cannot target a local id - generation must happen first - so
      // there is nothing to fold for it.
    }
    return [merged];
  }

  // Server lesson: at most one of each kind, last value winning.
  const result: OutboxOp[] = [];

  const patches = ops.filter((o): o is PatchOp => o.kind === "patch");
  if (patches.length > 0) {
    const first = patches[0];
    let merged: PatchOp = { kind: "patch", target: first.target, baseUpdatedAt: first.baseUpdatedAt };
    for (const p of patches) {
      merged = {
        ...merged,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.text !== undefined ? { text: p.text } : {}),
        ...(p.classId !== undefined ? { classId: p.classId } : {}),
        // Keep the OLDEST baseline: it is the state the tutor actually started
        // from, so the staleness check stays honest.
        baseUpdatedAt: Math.min(merged.baseUpdatedAt, p.baseUpdatedAt),
      };
    }
    result.push(merged);
  }

  const lastPublish = [...ops].reverse().find((o): o is PublishOp => o.kind === "publish");
  if (lastPublish) result.push(lastPublish);

  const lastMaterial = [...ops].reverse().find((o): o is MaterialOp => o.kind === "material");
  if (lastMaterial) result.push(lastMaterial);

  return result;
}

/** How the interface describes a queued op. Plain verbs, never system nouns. */
export function describe(op: OutboxOp): string {
  switch (op.kind) {
    case "create":
      return "New lesson";
    case "patch":
      return "Edit";
    case "publish":
      return "Publish";
    case "material":
      return op.publish ? "Publish material" : "Hide material";
    case "delete":
      return "Delete";
  }
}
