/**
 * Backfill lessons.studentPayload for lessons published before it existed.
 *
 * The offline sync bundle reads the study guide off the lesson doc so a whole
 * class syncs in ONE query (docs/OFFLINE-FIRST.md). Lessons published earlier
 * have no such field; the sync route repairs a few per request, but that is a
 * safety net, not a migration. Run this once after deploying.
 *
 * Dry run (default - reads only, writes nothing):
 *   npx tsx scripts/backfill-student-payload.ts <schoolId>
 * Commit:
 *   npx tsx scripts/backfill-student-payload.ts <schoolId> --commit
 * Rebuild payloads that already exist:
 *   npx tsx scripts/backfill-student-payload.ts <schoolId> --commit --force
 */
import process from "node:process";

// Load creds before touching firebase-admin, and init the Admin SDK directly -
// importing src/lib/firebase/admin pulls in Next's "server-only" guard, which
// doesn't resolve under tsx/node.
process.loadEnvFile(".env.local");

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { JD, QUERY_LIMIT } from "../src/lib/db/collections";

const schoolId = process.argv[2];
const commit = process.argv.includes("--commit");
const force = process.argv.includes("--force");

if (!schoolId || schoolId.startsWith("--")) {
  console.error(
    "Usage: npx tsx scripts/backfill-student-payload.ts <schoolId> [--commit] [--force]"
  );
  process.exit(1);
}

type LessonRow = {
  id: string;
  title: string;
  topicId: string;
  status?: string;
  hasPayload: boolean;
};

/** Mirrors toStudentPayload in src/lib/db/lessons.ts - names its fields so a
 *  marking guide cannot be copied in. Kept in sync deliberately; this script
 *  cannot import the server-only module. */
function toStudentPayload(
  summary: string,
  questions: { number: number; question: string }[],
  topicTitle: string
) {
  return { summary, questions, topicTitle, revision: Date.now() };
}

/** Newest generated content for a lesson, same rule as getGeneratedContent. */
async function latestContent(db: Firestore, lessonId: string) {
  const snap = await db
    .collection(JD.generatedContent)
    .where("lessonId", "==", lessonId)
    .limit(50)
    .get();
  if (snap.empty) return null;
  return snap.docs
    .map((d) => d.data() as {
      summary: string;
      questions: { number: number; question: string }[];
      version: number;
    })
    .sort((a, b) => b.version - a.version)[0];
}

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

  console.log(
    `${commit ? "COMMITTING" : "DRY RUN"} - school ${schoolId}${force ? " (force)" : ""}\n`
  );

  // One equality filter, bounded page, in-memory status filter - no composite
  // index needed (docs/firestore-indexes-to-append.md).
  let cursor: string | undefined;
  let reads = 0;
  let writes = 0;
  let skipped = 0;
  let missingContent = 0;
  const topicTitles = new Map<string, string>();

  for (;;) {
    let q = db
      .collection(JD.lessons)
      .where("schoolId", "==", schoolId)
      .orderBy("__name__")
      .limit(QUERY_LIMIT);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) break;
    reads += snap.size;

    const rows: LessonRow[] = snap.docs.map((d) => {
      const x = d.data() as {
        title: string;
        topicId: string;
        status?: string;
        studentPayload?: unknown;
      };
      return {
        id: d.id,
        title: x.title,
        topicId: x.topicId,
        status: x.status,
        hasPayload: !!x.studentPayload,
      };
    });

    for (const row of rows) {
      if (row.status !== "published") continue;
      if (row.hasPayload && !force) {
        skipped++;
        continue;
      }

      const content = await latestContent(db, row.id);
      reads++;
      if (!content) {
        // Published with no generated content - shouldn't happen (publish
        // requires it) but report rather than guess.
        missingContent++;
        console.warn(`  ! ${row.id} "${row.title}" is published with no generated content`);
        continue;
      }

      let topicTitle = topicTitles.get(row.topicId);
      if (topicTitle === undefined) {
        const t = await db.doc(`${JD.topics}/${row.topicId}`).get();
        reads++;
        topicTitle = (t.data() as { title?: string } | undefined)?.title ?? row.title;
        topicTitles.set(row.topicId, topicTitle);
      }

      const payload = toStudentPayload(content.summary, content.questions, topicTitle);

      if (commit) {
        await db.doc(`${JD.lessons}/${row.id}`).update({ studentPayload: payload });
      }
      writes++;
      console.log(
        `  ${commit ? "+" : "would write"} ${row.id} "${row.title}" ` +
          `(${payload.questions.length} questions, topic "${topicTitle}")`
      );
    }

    cursor = snap.docs[snap.docs.length - 1].id;
    if (snap.size < QUERY_LIMIT) break;
  }

  console.log(
    `\n${commit ? "Done" : "Dry run complete"}. ` +
      `${writes} payload${writes === 1 ? "" : "s"} ${commit ? "written" : "pending"}, ` +
      `${skipped} already present, ${missingContent} missing content.`
  );
  console.log(`Firestore document reads used: ~${reads}.`);
  if (!commit && writes > 0) console.log("Re-run with --commit to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
