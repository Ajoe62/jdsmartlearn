/**
 * Read-only: what would a school purge actually remove from JDSmartLearn?
 *
 *   npx tsx scripts/purge-report.ts <schoolId> [--max=5000]
 *   npm run report:purge -- <schoolId>
 *
 * WHY THIS EXISTS BEFORE ANYTHING THAT DELETES. When a school leaves, both
 * products have to remove what they hold, and ResultPeak's data policy already
 * promises that. Today its `schoolPurge.js` clears none of this product's
 * collections, so a departed school's homework, submissions and CA scores stay
 * behind. Before agreeing a protocol on the strength of a list somebody wrote by
 * reading the code, count the real rows in the real project.
 *
 * It is also the receipt. Run it before a purge to see what is about to go, and
 * again afterwards, when every line should read zero. "We deleted it" is a claim
 * made to a school in writing, and this is the evidence for it.
 *
 * WRITES NOTHING, AND THE HANDLE ENFORCES IT. `readOnlyDb()` wraps Firestore so
 * every write method throws, naming the path and the method. Do not unwrap it to
 * "just clean up the stragglers while we are here": that is the one edit this
 * file exists to make impossible, and the destructive half belongs in its own
 * reviewed route with ResultPeak's protocol agreed around it. See
 * `docs/resultpeak-deletion-protocol-prompt.md`.
 *
 * IT NEVER READS THE CONTENT. Every scan is `select()`ed down to the file-key
 * fields, so no marking guide and no child's answer is fetched, let alone
 * printed. A report about deletion must not become a copy of the data.
 *
 * COST, because the bill is shared with a live product and the project is on
 * Blaze now, where an unbounded scan succeeds and bills instead of failing
 * loudly. Collections with no files are counted with a Firestore aggregation -
 * one read per thousand documents rather than one per document. The three that
 * carry files are paged, because their keys can only come from the documents
 * themselves. Every query is equality-filtered on `schoolId`, ordered by
 * document id, and capped by --max. The read count is printed at the end.
 *
 * NO COMPOSITE INDEX. One equality filter ordered by document id, which the
 * automatic single-field index serves - the same shape as
 * scripts/diagnose-term-session.ts.
 */
import process from "node:process";

// Load creds before touching firebase-admin. The Admin SDK is initialised inline
// (below) rather than by importing src/lib/firebase/admin, which carries Next's
// "server-only" guard and resolves only inside the Next bundler.
try {
  process.loadEnvFile(".env.local");
} catch {
  console.error(
    "Could not load .env.local. Run this from the project root (c:\\Users\\DELL\\jdsmartlearn)."
  );
  process.exit(1);
}

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import type { DocumentData, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { RP } from "../src/lib/db/collections";
import { readOnlyDb } from "../src/lib/db/read-only";
import {
  PURGE_PLAN,
  assertPlanCoversJd,
  formatPurgeReport,
  type CollectionCount,
} from "../src/lib/db/purge-plan";

/** Documents per page. Keeps one response small on a slow line; not a cap. */
const PAGE_SIZE = 500;

/** Default ceiling per collection. Raise with --max when a school outgrows it. */
const DEFAULT_MAX = 5000;

const schoolId = process.argv[2];
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const max = maxArg ? Number(maxArg.slice("--max=".length)) : DEFAULT_MAX;

if (!schoolId || schoolId.startsWith("--") || !Number.isFinite(max) || max <= 0) {
  console.error("Usage: npx tsx scripts/purge-report.ts <schoolId> [--max=5000]");
  process.exit(1);
}

async function main() {
  // Fails here rather than after a scan if someone edited the plan badly.
  assertPlanCoversJd();

  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!privateKey || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PROJECT_ID) {
    console.error("Missing Firebase Admin credentials in .env.local.");
    process.exit(1);
  }
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  }

  // THE handle. Everything below reads through this and nothing can write.
  const db = readOnlyDb(getFirestore());

  let documentsRead = 0;

  /**
   * Count a collection without fetching its documents.
   *
   * `limit(max)` BEFORE `count()` on purpose: the aggregation respects it, so
   * the cap still governs and a school over the ceiling reports exactly `max`
   * rather than scanning without bound. That is the same rule the rest of the
   * codebase follows - the `.limit()` is the cap - and it is why a count equal
   * to `max` is reported as a floor rather than a total.
   */
  async function countOnly(collection: string): Promise<{ rows: number; capped: boolean }> {
    const snap = await db
      .collection(collection)
      .where("schoolId", "==", schoolId)
      .limit(max)
      .count()
      .get();
    const rows = snap.data().count;
    // An aggregation bills one read per 1000 index entries, minimum one.
    documentsRead += Math.max(1, Math.ceil(rows / 1000));
    return { rows, capped: rows >= max };
  }

  /**
   * Page a collection that carries files, pulling only the key fields.
   *
   * Ordered by document id rather than a data field, so the cursor needs no
   * composite index and no field every document is guaranteed to carry.
   */
  async function countWithFiles(
    collection: string,
    fields: string[],
    extract: (data: Record<string, unknown>) => string[]
  ): Promise<{ rows: number; capped: boolean; files: number }> {
    let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
    let rows = 0;
    /**
     * An array, de-duplicated at the end, rather than a Set accumulated as it
     * goes. A Set's insert method has the same name as Firestore's document
     * insert, and the source scan in scripts/test-offline.ts refuses that name
     * anywhere in this file so a real write can never slip in behind a plausible
     * one. Losing the Set is the price and it is the right way round: the scan
     * stays blunt, and blunt is what makes it hard to talk out of.
     */
    const keys: string[] = [];

    for (;;) {
      let query: Query<DocumentData> = db
        .collection(collection)
        .where("schoolId", "==", schoolId)
        .orderBy(FieldPath.documentId())
        .select(...fields)
        .limit(Math.min(PAGE_SIZE, max - rows));
      if (cursor) query = query.startAfter(cursor);

      const snap = await query.get();
      rows += snap.size;
      documentsRead += snap.size;
      for (const doc of snap.docs) {
        for (const key of extract(doc.data())) keys.push(key);
      }
      if (snap.size === 0 || rows >= max) {
        return { rows, capped: rows >= max && snap.size > 0, files: new Set(keys).size };
      }
      cursor = snap.docs[snap.size - 1] as QueryDocumentSnapshot<DocumentData>;
    }
  }

  /** The document id IS the schoolId, so one get replaces a query. */
  async function countByDocId(collection: string): Promise<{ rows: number; capped: boolean }> {
    const snap = await db.doc(`${collection}/${schoolId}`).get();
    documentsRead += 1;
    return { rows: snap.exists ? 1 : 0, capped: false };
  }

  /**
   * ResultPeak's school document. A MISSING one is not an error here: it is the
   * reconciliation case worth finding - a school purged on their side under the
   * old behaviour, whose rows are still sitting in this product.
   */
  const school = await db.doc(`${RP.schools}/${schoolId}`).get();
  documentsRead += 1;
  const schoolData = (school.data() ?? {}) as Record<string, unknown>;
  const schoolName = school.exists ? String(schoolData.name ?? schoolId) : null;
  const schoolActive = school.exists ? schoolData.isActive !== false : null;

  const counts: CollectionCount[] = [];
  for (const target of PURGE_PLAN) {
    // Scope decides the shape of the read; files decide whether it can be an
    // aggregation. Branch on scope FIRST, so a combination nobody has thought
    // about stops here instead of being silently counted the wrong way.
    let scanned: { rows: number; capped: boolean; files: number };
    if (target.scope.kind === "documentIsSchool") {
      if (target.files) {
        throw new Error(
          `${target.collection} is keyed by school AND carries files. That is a ` +
            `shape this report has never seen; work out what it should count ` +
            `before trusting a number for it.`
        );
      }
      scanned = { ...(await countByDocId(target.collection)), files: 0 };
    } else if (target.files) {
      scanned = await countWithFiles(
        target.collection,
        target.files.fields,
        target.files.extract
      );
    } else {
      scanned = { ...(await countOnly(target.collection)), files: 0 };
    }

    counts.push({
      collection: target.collection,
      rows: scanned.rows,
      capped: scanned.capped,
      files: scanned.files,
      holds: target.holds,
      prefixedBySchool: target.files ? target.files.prefixedBySchool : null,
    });
  }

  for (const line of formatPurgeReport({
    schoolId,
    schoolName,
    schoolActive,
    counts,
    documentsRead,
  })) {
    console.log(line);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
