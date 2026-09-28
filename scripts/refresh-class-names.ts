/**
 * After ResultPeak renames a class, bring JDSmartLearn's own copies in line.
 *
 * DRY RUN BY DEFAULT: prints what it would change and writes nothing. Add
 * --commit to write. One school at a time, and the school id is required.
 *
 * Two jobs, both on collections THIS repo owns (never a ResultPeak one):
 *
 *   1. `className` on lessons, schemes and assignments. It is denormalised on
 *      purpose (CLAUDE.md: keep read counts low), so when ResultPeak renames
 *      "JSS 1" to "Year 7" every copy still says "JSS 1" until this runs. The
 *      class's current name is read from `classes/{classId}.name`; the
 *      class id on each record is never touched, so nothing moves.
 *
 *   2. Retired `studentLogins` aliases that no longer match the child's
 *      username. resolveUsername() still falls back to `studentLogins`, so when
 *      ResultPeak reissues a username (Mt Cedar: "jss1-01" became "year7-001")
 *      the old alias would keep signing the child in here and nowhere else. An
 *      alias is deleted ONLY when `studentAccess/{studentId}.username` exists and
 *      is different; the thirty CAPSTONE children whose alias IS their username
 *      are left alone.
 *
 * Run it AFTER the rename in ResultPeak, not before: before, there is nothing
 * to change. Safe to run twice; a second run reports nothing to do.
 *
 *   npm run refresh:class-names -- dV6zL3AEydAFJc3D3GrO
 *   npm run refresh:class-names -- dV6zL3AEydAFJc3D3GrO --commit
 */
import process from "node:process";

// Load creds before touching firebase-admin. The Admin SDK is initialised inline
// rather than through src/lib/firebase/admin, whose "server-only" guard only
// resolves inside the Next bundler.
try {
  process.loadEnvFile(".env.local");
} catch {
  console.error(
    "Could not load .env.local. Run this from the project root (c:\\Users\\DELL\\jdsmartlearn)."
  );
  process.exit(1);
}

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { JD, RP, QUERY_LIMIT } from "../src/lib/db/collections";

const schoolId = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "";
const commit = process.argv.includes("--commit");

// Every JD collection that copies a class's name, keyed by its classId.
const COPIES = [JD.lessons, JD.schemes, JD.assignments];

async function main() {
  if (!schoolId) {
    console.error("Give the school id: npm run refresh:class-names -- <schoolId> [--commit]");
    process.exit(1);
  }
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

  const school = await db.doc(`${RP.schools}/${schoolId}`).get();
  if (!school.exists) {
    console.error(`No school ${schoolId}.`);
    process.exit(1);
  }
  console.log(`${commit ? "COMMIT" : "DRY RUN"}: ${school.get("name") || schoolId}\n`);

  const classes = await db
    .collection(RP.classes)
    .where("schoolId", "==", schoolId)
    .limit(QUERY_LIMIT)
    .get();
  const nameById = new Map(classes.docs.map((doc) => [doc.id, String(doc.get("name") || "")]));

  const writer = db.bulkWriter();
  let changes = 0;
  let failed = 0;
  const write = (label: string, op: Promise<unknown>) =>
    op.catch((error) => {
      failed += 1;
      console.error(`    could not write ${label}`, error);
    });

  // 1. className copies.
  for (const collection of COPIES) {
    const snap = await db.collection(collection).where("schoolId", "==", schoolId).get();
    const moves = new Map<string, number>();
    for (const doc of snap.docs) {
      const current = doc.get("className");
      const name = nameById.get(String(doc.get("classId") || ""));
      // A record whose class is gone keeps what it has; there is nothing to copy.
      if (!name || typeof current !== "string" || current === name) continue;
      const key = `"${current}" -> "${name}"`;
      moves.set(key, (moves.get(key) || 0) + 1);
      changes += 1;
      if (commit) write(doc.ref.path, writer.update(doc.ref, { className: name }));
    }
    console.log(`${collection}: ${snap.size} checked`);
    for (const [move, count] of moves) console.log(`    ${move}: ${count}`);
  }

  // 2. Stale studentLogins aliases.
  const logins = await db.collection(JD.studentLogins).where("schoolId", "==", schoolId).get();
  console.log(`\n${JD.studentLogins}: ${logins.size} checked`);
  for (const doc of logins.docs) {
    const studentId = String(doc.get("studentId") || "");
    const alias = String(doc.get("username") || "");
    const access = studentId ? await db.doc(`${RP.studentAccess}/${studentId}`).get() : null;
    const username = access?.exists ? String(access.get("username") || "") : "";
    if (!username || username === alias) continue;
    console.log(`    remove "${alias}" (this student's username is now "${username}")`);
    changes += 1;
    if (commit) write(doc.ref.path, writer.delete(doc.ref));
  }

  await writer.close();
  console.log(
    changes === 0
      ? "\nNothing to do."
      : commit
        ? `\n${changes - failed} change(s) written${failed ? `, ${failed} failed; run again` : ""}.`
        : `\n${changes} change(s) to make. Run again with --commit to write them.`
  );
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
