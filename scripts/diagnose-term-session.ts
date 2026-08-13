/**
 * Read-only diagnostic: will this school's marks actually join?
 *
 * Lists every distinct (term, session) pair on JDSmartLearn's assignments and
 * submissions for one school, counts the rows carrying each, and marks each pair
 * matched or unmatched against what that school's ResultPeak data contains.
 *
 *   npx tsx scripts/diagnose-term-session.ts <schoolId> [--max=3000]
 *
 * WHY, AND WHY BEFORE THE PILOT. ResultPeak joins a term's marks by exact string
 * match, and is gaining an end-of-session annual average computed from the three
 * term percentages. A pair that does not match does not error and does not blank
 * a report: the term drops out of the join and the annual figure still prints a
 * plausible number. The live project already carries the condition, so this is
 * not a precaution. Run it and read the output before a single parent does.
 *
 * WRITES NOTHING, AND THE HANDLE ENFORCES IT. `readOnlyDb()` wraps the Firestore
 * instance so every write method throws, naming the path and the method. Do not
 * unwrap it to "just fix the fifty rows while we are here": which of two session
 * strings a school's history should collapse onto is a decision about a paying
 * school's result sheets, and it belongs to whoever owns those sheets.
 *
 * COST, because the Spark quota is shared with a live school. One scan of
 * `assignments` and `submissions` (JDSmartLearn's own, small), and one of `exams`
 * and `results` (ResultPeak's, and `results` is the big one: 2752 rows for the
 * pilot school on 2026-08-13). Every scan is equality-filtered on `schoolId`,
 * projected to two fields, paged, and capped by --max. The read count is printed
 * at the end. Run it deliberately, not on a loop, and never from a route.
 *
 * NO COMPOSITE INDEX. Every query here is one equality filter ordered by
 * document id, which the automatic single-field index serves. Verified against
 * the real project on 2026-08-13, not reasoned about: see
 * docs/firestore-indexes-to-append.md.
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
import { JD, RP } from "../src/lib/db/collections";
import { readOnlyDb } from "../src/lib/db/read-only";
import {
  auditTermSessions,
  formatReport,
  type JdRow,
  type RpRow,
} from "../src/lib/assessment/term-session-audit";

/** Documents per page. Keeps one response small on a slow line; not a cap. */
const PAGE_SIZE = 500;

/** Default ceiling per collection. Raise with --max when a school outgrows it. */
const DEFAULT_MAX = 3000;

const schoolId = process.argv[2];
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const max = maxArg ? Number(maxArg.slice("--max=".length)) : DEFAULT_MAX;

if (!schoolId || schoolId.startsWith("--") || !Number.isFinite(max) || max <= 0) {
  console.error("Usage: npx tsx scripts/diagnose-term-session.ts <schoolId> [--max=3000]");
  process.exit(1);
}

interface Scan<T> {
  rows: T[];
  read: number;
  /** True when the cap stopped the scan early, so the pair list may be short. */
  capped: boolean;
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

  // THE handle. Everything below reads through this and nothing can write.
  const db = readOnlyDb(getFirestore());

  /**
   * One collection, scanned for its term and session fields only.
   *
   * Ordered by document id rather than by a data field, so the paging cursor
   * needs no composite index and no field that every document is guaranteed to
   * carry. `select()` keeps the payload to two fields; it does not reduce the
   * read count, which is why the cap exists as well.
   */
  async function scan<S extends string>(
    collection: string,
    termField: string,
    sessionField: string,
    source: S
  ): Promise<Scan<{ term: unknown; session: unknown; source: S }>> {
    const rows: { term: unknown; session: unknown; source: S }[] = [];
    let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
    let read = 0;

    for (;;) {
      let query: Query<DocumentData> = db
        .collection(collection)
        .where("schoolId", "==", schoolId)
        .orderBy(FieldPath.documentId())
        .select(termField, sessionField)
        .limit(Math.min(PAGE_SIZE, max - read));
      if (cursor) query = query.startAfter(cursor);

      const snap = await query.get();
      read += snap.size;
      for (const doc of snap.docs) {
        const data = doc.data();
        rows.push({ term: data[termField], session: data[sessionField], source });
      }
      if (snap.size === 0 || read >= max) {
        return { rows, read, capped: read >= max && snap.size > 0 };
      }
      cursor = snap.docs[snap.size - 1] as QueryDocumentSnapshot<DocumentData>;
    }
  }

  const school = await db.doc(`${RP.schools}/${schoolId}`).get();
  if (!school.exists) {
    console.error(`No school ${schoolId}. Check the id against ResultPeak.`);
    process.exit(1);
  }
  const schoolData = (school.data() ?? {}) as Record<string, unknown>;

  const [assignments, submissions, exams, results] = await Promise.all([
    scan(JD.assignments, "term", "session", "assignments" as const),
    scan(JD.submissions, "term", "session", "submissions" as const),
    // ResultPeak's own field names. `academicSession` there, `session` here, and
    // neither is renamed on the way through: the diagnostic reports strings, so
    // it must read the string each side actually stores.
    scan(RP.exams, "term", "academicSession", "exams" as const),
    scan(RP.results, "term", "academicSession", "results" as const),
  ]);

  const jd: JdRow[] = [...assignments.rows, ...submissions.rows];
  const rp: RpRow[] = [...exams.rows, ...results.rows];

  /**
   * The school's own statement of where it is now, if ResultPeak has one yet.
   *
   * READ HERE AND NOWHERE ELSE, AND WITH NO FALLBACK. This is a line in a report,
   * not a settings read: the precedence between the school profile and
   * `jdSchoolSettings` belongs to readLmsSettings() on the ResultPeak side and
   * must live in exactly one place. Do not add a fallback here, and do not read
   * the jdSchoolSettings panel from this script.
   */
  const statedTerm = schoolData.currentTerm;
  const statedSession = schoolData.currentSession;
  const stated =
    typeof statedTerm === "string" &&
    statedTerm !== "" &&
    typeof statedSession === "string" &&
    statedSession !== "";
  if (stated) {
    rp.push({ term: statedTerm, session: statedSession, source: "school profile" });
  }

  const report = auditTermSessions(jd, rp);

  console.log("");
  console.log(`  ${String(schoolData.name ?? "(unnamed school)")}`);
  console.log("");
  for (const line of formatReport(report, schoolId)) console.log(line);

  console.log("");
  console.log("  Scanned");
  const scans: [string, Scan<unknown>][] = [
    [`${JD.assignments} (JDSmartLearn)`, assignments],
    [`${JD.submissions} (JDSmartLearn)`, submissions],
    [`${RP.exams} (ResultPeak, read-only)`, exams],
    [`${RP.results} (ResultPeak, read-only)`, results],
  ];
  for (const [label, s] of scans) {
    console.log(`    ${String(s.read).padStart(5)} row(s)  ${label}${s.capped ? "  CAPPED" : ""}`);
  }
  console.log(
    `    ${String(scans.reduce((n, [, s]) => n + s.read, 0)).padStart(5)} document read(s) in total.`
  );

  const capped = scans.filter(([, s]) => s.capped);
  if (capped.length > 0) {
    console.log("");
    console.log(
      `  A scan stopped at the --max=${max} cap, so a pair further down that collection was not seen.`
    );
    console.log(
      "  A missed ResultPeak pair shows as an unmatched JDSmartLearn pair, so the error is a false"
    );
    console.log("  alarm rather than a false all-clear. Re-run with a higher --max to be certain.");
  }

  console.log("");
  if (stated) {
    console.log(
      `  The school profile states "${String(statedTerm)}" / "${String(statedSession)}" as current.`
    );
  } else {
    console.log(
      "  The school profile states no current term and session yet, so it matched nothing above."
    );
    console.log(
      "  That field is ResultPeak's to set. This script deliberately does not fall back to the"
    );
    console.log("  JDSmartLearn setting: the precedence between the two lives on the ResultPeak side.");
  }

  /**
   * A split term counts. It is not a JDSmartLearn row and nothing here caused
   * it, but it is a term of one school year already divided across two result
   * sheets, and a pilot that starts on top of it inherits the division.
   */
  const findings =
    report.totals.unmatchedPairs + report.malformed.length + report.splitTerms.length;
  console.log("");
  if (findings === 0) {
    console.log("  Every pair matches, and no term is split. Nothing here would drop out of a join.");
  } else {
    console.log(
      `  ${findings} finding(s). Each one is marks that drop out of a join without erroring, ` +
        "leaving a plausible-looking figure behind."
    );
    console.log("  Nothing was changed. Deciding what a row should say is ResultPeak's call.");
  }
  console.log("");

  // Non-zero on a finding, so a pilot checklist can gate on it. The wording above
  // is what a person reads; this is what a script reads.
  process.exit(findings === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
