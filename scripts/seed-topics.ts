/**
 * Seed curriculum topics.
 *
 * Upserts by document id so topic ids stay PERMANENT across reseeds -
 * ResultPeak exam questions will be tagged with these ids.
 *
 *   npx tsx scripts/seed-topics.ts <schoolId>
 */
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Load creds before touching firebase-admin, and init the Admin SDK directly -
// importing src/lib/firebase/admin pulls in Next's "server-only" guard, which
// doesn't resolve under tsx/node.
process.loadEnvFile(".env.local");

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { JD } from "../src/lib/db/collections";

const schoolId = process.argv[2];
if (!schoolId) {
  console.error("Usage: npx tsx scripts/seed-topics.ts <schoolId>");
  process.exit(1);
}

const dir = join(process.cwd(), "seed/topics");

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
  const adminDb = getFirestore();

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let count = 0;

  for (const file of files) {
    const pack = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const batch = adminDb.batch();

    for (const topic of pack.topics) {
      batch.set(
        adminDb.doc(`${JD.topics}/${topic.id}`),
        {
          schoolId,
          subjectId: pack.subjectId,
          level: pack.level,
          term: topic.term,
          position: topic.position,
          title: topic.title,
          objectives: topic.objectives ?? [],
          isCustom: false,
          createdAt: Date.now(),
        },
        { merge: true }
      );
      count++;
    }
    await batch.commit();
    console.log(`Seeded ${pack.topics.length} topics from ${file}`);
  }
  console.log(`\nDone. ${count} topics upserted for school ${schoolId}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
