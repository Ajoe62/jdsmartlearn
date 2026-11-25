/**
 * Move JDSmartLearn's own CA score copies onto the id that includes the column.
 *
 *   npm run migrate:ca-scores -- <schoolId>            report only (default)
 *   npm run migrate:ca-scores -- <schoolId> --apply    make the changes
 *
 * WHY. `jdCaScores` used to hold one document per student, subject, session and
 * term. Once assignments could choose their own report-card column, the column
 * joined the id (`caScoreId` in src/lib/assessment/ca.ts). Documents written
 * before that still sit under the old id (`legacyCaScoreId`), so one column can
 * have two copies, and a rebuild from this collection could put the older score
 * back. New writes already retire the old copy for their own column; this moves
 * the rest.
 *
 * WHAT IT TOUCHES. `jdCaScores` only, JDSmartLearn's own collection, guarded by
 * assertWritable. It never reads or writes `studentAcademicRecords` or any
 * ResultPeak collection: the shared record is keyed by column already and is
 * not affected.
 *
 * PER DOCUMENT, in one transaction:
 *   - old id, no copy under the new id  -> copy to the new id, delete the old
 *   - old id, a copy under the new id   -> keep whichever was updated later
 *                                          under the new id, delete the old
 *   - old id with no column recorded    -> reported, left alone
 *
 * NO COMPOSITE INDEX: one equality filter ordered by document id.
 */
import process from "node:process";

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
import type { DocumentData, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { JD } from "../src/lib/db/collections";
import { assertWritable } from "../src/lib/db/write-guard";
import { caScoreId, legacyCaScoreId } from "../src/lib/assessment/ca";

const PAGE_SIZE = 500;
const DEFAULT_MAX = 5000;

const schoolId = process.argv[2];
const apply = process.argv.includes("--apply");
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const max = maxArg ? Number(maxArg.slice("--max=".length)) : DEFAULT_MAX;

if (!schoolId || schoolId.startsWith("--") || !Number.isFinite(max) || max <= 0) {
  console.error("Usage: npm run migrate:ca-scores -- <schoolId> [--apply] [--max=5000]");
  process.exit(1);
}

type Score = {
  schoolId: string;
  studentId: string;
  subjectId: string;
  session: string;
  term: string;
  assessmentTypeId?: string;
  updatedAt?: number;
};

async function main() {
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
  const db = getFirestore();
  if (apply) assertWritable(JD.caScores);

  const legacy: QueryDocumentSnapshot<DocumentData>[] = [];
  let read = 0;
  let cursor: string | null = null;
  let capped = false;
  for (;;) {
    let q = db
      .collection(JD.caScores)
      .where("schoolId", "==", schoolId)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    read += snap.size;
    for (const d of snap.docs) {
      const s = d.data() as Score;
      if (d.id === legacyCaScoreId(s)) legacy.push(d);
    }
    if (snap.size < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1].id;
    if (read >= max) {
      capped = true;
      break;
    }
  }

  let moved = 0;
  let merged = 0;
  let noColumn = 0;
  for (const d of legacy) {
    const s = d.data() as Score;
    if (!s.assessmentTypeId) {
      noColumn += 1;
      console.log(`LEAVE   ${d.id}  (no column recorded)`);
      continue;
    }
    const newRef = db.doc(`${JD.caScores}/${caScoreId({ ...s, assessmentTypeId: s.assessmentTypeId })}`);
    if (!apply) {
      const existing = await newRef.get();
      console.log(`${existing.exists ? "MERGE " : "MOVE  "}  ${d.id}  ->  ${newRef.id}`);
      if (existing.exists) merged += 1;
      else moved += 1;
      continue;
    }
    const outcome = await db.runTransaction(async (tx) => {
      const [oldSnap, newSnap] = await Promise.all([tx.get(d.ref), tx.get(newRef)]);
      if (!oldSnap.exists) return "gone" as const;
      const oldData = oldSnap.data() as Score;
      const newData = newSnap.exists ? (newSnap.data() as Score) : null;
      if (!newData || (oldData.updatedAt ?? 0) > (newData.updatedAt ?? 0)) {
        tx.set(newRef, oldData);
      }
      tx.delete(d.ref);
      return newData ? ("merged" as const) : ("moved" as const);
    });
    if (outcome === "moved") moved += 1;
    if (outcome === "merged") merged += 1;
    console.log(`${outcome.toUpperCase().padEnd(6)}  ${d.id}  ->  ${newRef.id}`);
  }

  console.log("");
  console.log(`School ${schoolId}: ${read} score copies read, ${legacy.length} under the old id.`);
  console.log(`  ${moved} ${apply ? "moved" : "would move"}, ${merged} ${apply ? "merged" : "would merge"}, ${noColumn} left alone (no column).`);
  if (capped) console.log(`  Stopped at --max=${max}. Run again with a higher --max to see the rest.`);
  if (!apply && legacy.length > noColumn) console.log("  Nothing was changed. Add --apply to make these changes.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
