import { RESULTPEAK_OWNED } from "./collections";

/**
 * Throws if code attempts to write to a ResultPeak-owned collection.
 * ResultPeak is live with a paying school; an accidental write here is a
 * production incident, not a bug.
 */
export function assertWritable(collectionPath: string): void {
  const root = collectionPath.split("/")[0];
  if (RESULTPEAK_OWNED.has(root)) {
    throw new Error(
      `Refusing to write to "${collectionPath}". ResultPeak owns this collection; ` +
        `JDSmartLearn is read-only here. See CLAUDE.md.`
    );
  }
}
