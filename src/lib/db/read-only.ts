import { assertNoWrite } from "./write-guard";

/**
 * A Firestore handle that can read and cannot write.
 *
 * WHAT THIS IS FOR. A diagnostic reads a paying school's live data to report
 * what is wrong with it. The dangerous edit is not a typo, it is a good
 * intention: somebody runs the report, sees fifty rows carrying a wrong session
 * string, and adds "while we are here" to the bottom of the script. That edit
 * looks small, touches a live result sheet, and gets no review because the file
 * is called a diagnostic. Wrapping the handle makes that edit fail on the first
 * run instead of succeeding quietly.
 *
 * NO `server-only`, deliberately. The scripts import this by relative path under
 * tsx, exactly like `write-guard` and `collections`, and `server-only` resolves
 * only inside the Next bundler.
 *
 * WHAT IT DOES NOT COVER, stated plainly rather than left to be discovered. It
 * guards the handle, not the whole object graph reachable from it. A snapshot's
 * `.ref` is a live writable reference that this wrapper never sees, so
 * `snap.docs[0].ref.delete()` would go through. That path is covered separately
 * by the source scan in `scripts/test-offline.ts`, which refuses a write method
 * anywhere in the diagnostic's own text. Two partial guards over one narrow file
 * beats one guard that pretends to be total.
 *
 * Generic over the handle rather than typed against `Firestore`, so this file
 * imports no firebase-admin type and stays importable from anywhere.
 */

/** Methods that write through a document or collection reference. */
const WRITE_METHODS = new Set(["set", "update", "delete", "create", "add"]);

/**
 * Entry points that exist to write, or that can. `runTransaction` can read, but
 * a diagnostic has no reason to hold a transaction open against a live project,
 * and its callback receives a writable transaction object this wrapper does not
 * see.
 */
const REFUSED_ENTRYPOINTS = new Set([
  "batch",
  "bulkWriter",
  "runTransaction",
  "recursiveDelete",
]);

/** The path a reference reports for itself, or a best effort for the message. */
function pathOf(ref: unknown, fallback: string): string {
  const candidate = (ref as { path?: unknown } | null)?.path;
  return typeof candidate === "string" ? candidate : fallback;
}

/**
 * Wrap one reference. `doc()` and `collection()` hand back further references,
 * so those are wrapped in turn; everything else (`where`, `orderBy`, `limit`,
 * `select`, `startAfter`, `get`) returns a Query or a snapshot, neither of which
 * can write.
 */
function wrapRef<T extends object>(ref: T, path: string): T {
  return new Proxy(ref, {
    get(target, prop) {
      const name = String(prop);
      if (WRITE_METHODS.has(name)) {
        return () => assertNoWrite(path, name);
      }

      // `target` as the receiver, not the proxy: firebase-admin's getters read
      // internal fields, and handing them the proxy makes them throw somewhere
      // far from here with a message about a private property.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;

      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if ((name === "doc" || name === "collection") && result && typeof result === "object") {
          const child = typeof args[0] === "string" ? `${path}/${args[0]}` : `${path}/(generated)`;
          return wrapRef(result as object, pathOf(result, child));
        }
        return result;
      };
    },
  });
}

/**
 * THE read-only wrapper. Give a diagnostic this instead of the Firestore
 * instance, and every write it could reach through the handle throws with a
 * message naming the path and the method.
 */
export function readOnlyDb<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop) {
      const name = String(prop);
      if (REFUSED_ENTRYPOINTS.has(name)) {
        return () => assertNoWrite("(the whole database)", name);
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;

      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (
          (name === "doc" || name === "collection" || name === "collectionGroup") &&
          result &&
          typeof result === "object"
        ) {
          const first = typeof args[0] === "string" ? args[0] : "(unknown)";
          return wrapRef(result as object, pathOf(result, first));
        }
        return result;
      };
    },
  });
}
