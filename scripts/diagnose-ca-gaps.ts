/**
 * Read-only diagnostic: released marks that never reached a report card.
 *
 *   npm run diagnose:ca-gaps -- <schoolId> [--max=3000]
 *
 * WHY. Until 2026-11-26 a report-card send that failed after a mark was
 * released left no trace: the child saw the mark, the report card never got it,
 * and nothing recorded the gap. Releases since then record the outcome on the
 * submission (`caSync`) and offer the tutor "Send to report card again". This
 * finds the rest, including every mark released before that record existed.
 *
 * WHAT IT COMPARES. Every finalised submission against `jdCaScores`, which is
 * what ResultPeak's fold reads. A finalised mark whose student, subject,
 * session, term and column has no `jdCaScores` row is not on any report card.
 *
 * WHAT IT DOES ABOUT IT. Nothing. `readOnlyDb()` makes every write throw. The
 * fix for a gap is the tutor's "Send to report card again" on that row, which
 * recomputes the average through the one sanctioned path. A script that wrote
 * report-card marks in bulk would be a second path, and a second path is how a
 * paying school's result sheet changes without anyone deciding it should.
 *
 * COST. Three schoolId-filtered, projected, capped scans of JD's own
 * collections plus two document reads. No ResultPeak collection is scanned.
 */
import process from "node:process";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.error("Could not load .env.local. Run this from the project root.");
  process.exit(1);
}

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { JD, RP } from "../src/lib/db/collections";
import { readOnlyDb } from "../src/lib/db/read-only";
import { caColumnOf } from "../src/lib/assessment/ca";

const schoolId = process.argv[2];
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const max = maxArg ? Number(maxArg.slice("--max=".length)) : 3000;

if (!schoolId || schoolId.startsWith("--") || !Number.isFinite(max) || max <= 0) {
  console.error("Usage: npm run diagnose:ca-gaps -- <schoolId> [--max=3000]");
  process.exit(1);
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
  const db = readOnlyDb(getFirestore());
  let reads = 0;

  const [school, settings] = await Promise.all([
    db.doc(`${RP.schools}/${schoolId}`).get(),
    db.doc(`${JD.schoolSettings}/${schoolId}`).get(),
  ]);
  reads += 2;
  if (!school.exists) {
    console.error(`No school ${schoolId}.`);
    process.exit(1);
  }
  const raw = settings.exists ? settings.get("lmsAssessmentType") : null;
  const adminColumn = typeof raw === "string" && raw ? raw : null;

  const subs = await db
    .collection(JD.submissions)
    .where("schoolId", "==", schoolId)
    .where("status", "==", "finalised")
    .select("studentId", "subjectId", "subjectName", "term", "session", "assessmentTypeId", "assignmentTitle", "caSync")
    .limit(max)
    .get();
  reads += subs.size;

  const ca = await db
    .collection(JD.caScores)
    .where("schoolId", "==", schoolId)
    .select("studentId", "subjectId", "session", "term", "assessmentTypeId")
    .limit(max)
    .get();
  reads += ca.size;

  const key = (p: { studentId: string; subjectId: string; session: string; term: string; column: string }) =>
    [p.studentId, p.subjectId, p.session, p.term, p.column].join("\u0000");
  const have = new Set(
    ca.docs.map((d) => {
      const c = d.data() as {
        studentId: string; subjectId: string; session: string; term: string; assessmentTypeId: string;
      };
      return key({ ...c, column: c.assessmentTypeId });
    })
  );

  type Gap = { id: string; title: string; subject: string; term: string; why: string };
  const gaps: Gap[] = [];
  const noColumn: Gap[] = [];
  const recorded = { written: 0, skipped: 0, failed: 0, unknown: 0 };

  for (const d of subs.docs) {
    const s = d.data() as {
      studentId: string; subjectId: string; subjectName?: string; term: string; session: string;
      assessmentTypeId?: string; assignmentTitle?: string; caSync?: { status: string; reason?: string };
    };
    recorded[(s.caSync?.status as keyof typeof recorded) ?? "unknown"] =
      (recorded[(s.caSync?.status as keyof typeof recorded) ?? "unknown"] ?? 0) + 1;
    const row = {
      id: d.id,
      title: s.assignmentTitle ?? "?",
      subject: s.subjectName ?? s.subjectId,
      term: `${s.term} ${s.session}`,
    };
    const column = caColumnOf(s, adminColumn);
    if (!column) {
      noColumn.push({ ...row, why: "no report-card column chosen" });
      continue;
    }
    if (!have.has(key({ ...s, column }))) {
      gaps.push({
        ...row,
        why: s.caSync ? `recorded as ${s.caSync.status}${s.caSync.reason ? ` (${s.caSync.reason})` : ""}` : "released before outcomes were recorded",
      });
    }
  }

  console.log(`${school.get("name")} (${schoolId})`);
  console.log(`  ${subs.size} released marks${subs.size >= max ? " (CAPPED - raise --max)" : ""}, ${ca.size} report-card rows`);
  console.log(`  admin column: ${adminColumn ?? "not chosen"}`);
  console.log(`  recorded outcomes: ${JSON.stringify(recorded)}`);

  if (gaps.length === 0 && noColumn.length === 0) {
    console.log("\n  No gaps. Every released mark has a report-card row.");
  }
  if (gaps.length > 0) {
    console.log(`\n  [!!] ${gaps.length} released mark(s) with NO report-card row:`);
    for (const g of gaps.slice(0, 50)) console.log(`       ${g.id}  ${g.subject} / ${g.title} / ${g.term}: ${g.why}`);
    if (gaps.length > 50) console.log(`       ...and ${gaps.length - 50} more`);
    console.log("       Fix: the tutor opens each row and presses \"Send to report card again\".");
  }
  if (noColumn.length > 0) {
    console.log(`\n  [!!] ${noColumn.length} released mark(s) with no column to go to.`);
    console.log("       Fix: a school admin chooses a column in Assessment settings, then tutors send again.");
  }
  console.log(`\n  reads: ${reads}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
