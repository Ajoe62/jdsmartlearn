import { JD, RESULTPEAK_OWNED, SHARED } from "./collections";

/**
 * WHAT A SCHOOL PURGE WOULD REMOVE FROM JDSMARTLEARN, AS DATA.
 *
 * One entry per collection this product owns, saying how that collection is
 * scoped to a school and where its files hang. Nothing here deletes; this module
 * is the plan, and `scripts/purge-report.ts` is the read-only tool that counts
 * against it. The destructive half is deliberately not built yet - see
 * `docs/resultpeak-deletion-protocol-prompt.md` for why it waits on ResultPeak.
 *
 * THIS TABLE EXISTS BECAUSE THE ALTERNATIVE ALREADY FAILED. ResultPeak's
 * `schoolPurge.js` clears its own collections against a hardcoded list, and this
 * product kept adding collections without that list being updated. Nothing broke
 * and nothing errored: a departed school's homework, submissions and CA scores
 * simply stayed behind, while the data policy told schools deletion cascades.
 * A second hardcoded list here would be the same bug with the clock reset, so
 * `scripts/test-offline.ts` asserts that every key in `JD` appears here exactly
 * once and the build fails otherwise. Adding a collection to `collections.ts`
 * without adding it here is not a thing that can ship.
 *
 * NO `server-only`. The scripts import this by relative path under tsx, exactly
 * like `collections`, `write-guard` and `read-only`.
 */

/** How a collection's documents are narrowed to one school. */
export type PurgeScope =
  /** `where("schoolId", "==", id)`. The tenant spine; almost everything. */
  | { kind: "schoolIdField" }
  /**
   * The document id IS the schoolId, so one `get()` replaces a query. Cheaper
   * and exact. `saveSchoolSettings` does also write a `schoolId` field, so a
   * query would work today - but the id is the contract and the field is a
   * convenience, and a purge should key on the contract.
   */
  | { kind: "documentIsSchool" };

/** Where a document's stored files hang, when it has any. */
export interface FileLocator {
  /**
   * Fields to `select()`. Keeping this narrow is not only about read size: a
   * `select()` on the key fields means a purge report never pulls a marking
   * guide out of `assignments` or a child's answer out of `submissions`. A
   * report about deletion should not itself become a copy of the data.
   */
  fields: string[];
  /** Pull every R2 key out of one document's selected fields. */
  extract(data: Record<string, unknown>): string[];
  /**
   * True when the key begins `{collection}/{schoolId}/`, so the objects can be
   * listed by prefix and a purge can be VERIFIED rather than merely executed.
   * False for historic lesson keys - see the note on `lessons` below.
   */
  prefixedBySchool: boolean;
}

export interface PurgeTarget {
  collection: string;
  scope: PurgeScope;
  files?: FileLocator;
  /** What is lost, in the terms a school would use. Printed in the report. */
  holds: string;
}

/** `attachments: [{ key, name, type, size }]` on a submission. */
function attachmentKeys(data: Record<string, unknown>): string[] {
  const list = data.attachments;
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => (a as { key?: unknown } | null)?.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

/** A single optional `fileKey` on a lesson or a scheme. */
function fileKey(data: Record<string, unknown>): string[] {
  const key = data.fileKey;
  return typeof key === "string" && key.length > 0 ? [key] : [];
}

/**
 * EVERY COLLECTION JDSMARTLEARN OWNS. Order is the order the report prints in:
 * the things a school would recognise first, the bookkeeping last.
 */
export const PURGE_PLAN: readonly PurgeTarget[] = [
  {
    collection: JD.assignments,
    scope: { kind: "schoolIdField" },
    holds: "homework set by tutors, including marking guides",
  },
  {
    collection: JD.submissions,
    scope: { kind: "schoolIdField" },
    files: { fields: ["attachments"], extract: attachmentKeys, prefixedBySchool: true },
    holds: "children's answers, their scores and their attachments",
  },
  {
    collection: JD.lessons,
    scope: { kind: "schoolIdField" },
    /**
     * NOT PREFIXED BY SCHOOL, and it is the only one. Historic keys are
     * `lessons/{lessonId}/original{ext}`, written before the purge protocol
     * existed. Deletion is unaffected - the key is read from the document, which
     * is the source of truth either way - but there is no drawer to look in
     * afterwards and confirm a school's lesson files are gone. New uploads use
     * `lessons/{schoolId}/{lessonId}/original{ext}`; old keys keep working
     * untouched, so there is nothing to migrate.
     */
    files: { fields: ["fileKey"], extract: fileKey, prefixedBySchool: false },
    holds: "uploaded lesson material and its extracted text",
  },
  {
    collection: JD.generatedContent,
    scope: { kind: "schoolIdField" },
    holds: "AI summaries, practice questions and marking guides",
  },
  {
    collection: JD.schemes,
    scope: { kind: "schoolIdField" },
    files: { fields: ["fileKey"], extract: fileKey, prefixedBySchool: true },
    holds: "schemes of work uploaded by tutors",
  },
  {
    collection: JD.topics,
    scope: { kind: "schoolIdField" },
    holds: "the curriculum topic list",
  },
  {
    collection: JD.studentProgress,
    scope: { kind: "schoolIdField" },
    holds: "per-student, per-subject progress",
  },
  {
    collection: JD.caScores,
    scope: { kind: "schoolIdField" },
    holds: "every CA percentage this product calculated for a child",
  },
  {
    collection: JD.notifications,
    scope: { kind: "schoolIdField" },
    holds: "school announcements and the class activity feed",
  },
  {
    collection: JD.readState,
    scope: { kind: "schoolIdField" },
    holds: "what each reader has already seen",
  },
  {
    collection: JD.lessonViews,
    scope: { kind: "schoolIdField" },
    holds: "which lessons were opened, and when",
  },
  {
    collection: JD.studentLogins,
    scope: { kind: "schoolIdField" },
    holds: "username aliases (no names, no access codes)",
  },
  {
    collection: JD.schoolSettings,
    scope: { kind: "documentIsSchool" },
    holds: "the school's current term and session",
  },
  {
    collection: JD.auditLogs,
    scope: { kind: "schoolIdField" },
    holds: "the record of who did what in this product",
  },
];

/**
 * Deleted by RESULTPEAK, not from here, and named in the report so the totals
 * are not misread as the whole story.
 *
 * `studentAcademicRecords` is owned by neither platform and keyed
 * `{schoolId}_{studentId}`. ResultPeak already enumerates students; this product
 * would have to read the roster to find them, and its write guard there is a
 * field allowlist over a LIVE document - the wrong thing to widen into a delete
 * path. ResultPeak must also delete it AFTER this side has stopped writing,
 * because `writeContinuousAssessment` uses `set(..., { merge: true })` and a
 * merge-set recreates a deleted document.
 */
export const PURGED_BY_RESULTPEAK: readonly { collection: string; note: string }[] = [
  {
    collection: SHARED.studentAcademicRecords,
    note: "owned by neither product; ResultPeak deletes it, and only after this side stops",
  },
  {
    collection: "schoolBranding",
    note: "ResultPeak's projection; already in its cascade",
  },
];

/**
 * Guard for the plan itself, so a bad edit fails loudly rather than quietly.
 *
 * Takes the plan as an argument so the tests can feed it a broken one. A guard
 * that has only ever been run against the correct input is a guard nobody has
 * seen refuse anything.
 */
export function assertPlanCoversJd(plan: readonly PurgeTarget[] = PURGE_PLAN): void {
  const owned = new Set<string>(Object.values(JD));
  const planned = plan.map((t) => t.collection);

  for (const name of planned) {
    if (RESULTPEAK_OWNED.has(name)) {
      throw new Error(
        `Purge plan names "${name}", which ResultPeak owns. This product never ` +
          `deletes another product's collection. See CLAUDE.md.`
      );
    }
    if (!owned.has(name)) {
      throw new Error(
        `Purge plan names "${name}", which is not in JD in collections.ts. ` +
          `Either it is not ours to delete, or collections.ts is missing it.`
      );
    }
  }

  const seen = new Set(planned);
  if (seen.size !== planned.length) {
    throw new Error("Purge plan lists a collection twice.");
  }

  const missing = [...owned].filter((c) => !seen.has(c));
  if (missing.length) {
    throw new Error(
      `Purge plan is missing ${missing.join(", ")}. A collection this product ` +
        `owns but never deletes is a school's data left behind after they leave. ` +
        `Add it to PURGE_PLAN in db/purge-plan.ts.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  The report                                                                 */
/* -------------------------------------------------------------------------- */

export interface CollectionCount {
  collection: string;
  /** Documents found. `capped` says whether the scan stopped at --max. */
  rows: number;
  capped: boolean;
  /** R2 keys resolved from those documents. */
  files: number;
  holds: string;
  prefixedBySchool: boolean | null;
}

export interface PurgeReport {
  schoolId: string;
  /** From ResultPeak. `null` when the school document is already gone. */
  schoolName: string | null;
  schoolActive: boolean | null;
  counts: CollectionCount[];
  /** Documents actually read, so the cost of running this is never a mystery. */
  documentsRead: number;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

const n = (value: number) => value.toLocaleString("en-GB");

/**
 * The whole report, as lines. Pure, so the shape of the output is testable and a
 * reviewer can read what it will say without running it against a live school.
 */
export function formatPurgeReport(report: PurgeReport): string[] {
  const out: string[] = [];
  // Widest name in EITHER list. `studentAcademicRecords` is the longest thing
  // printed and it lives in the footer, so sizing on the counts alone breaks the
  // column exactly where a reader is being told what this report does not cover.
  const nameWidth = Math.max(
    ...report.counts.map((c) => c.collection.length),
    ...PURGED_BY_RESULTPEAK.map((p) => p.collection.length),
    16
  );

  out.push("");
  out.push("SCHOOL PURGE REPORT - DRY RUN. NOTHING WAS DELETED.");
  out.push("");

  if (report.schoolName === null) {
    out.push(`School:  ${report.schoolId}`);
    out.push("");
    out.push("  ResultPeak has NO school document for this id, but the rows below");
    out.push("  still exist here. This is a school purged under the old behaviour,");
    out.push("  before the two products agreed a protocol. Deleting a former");
    out.push("  customer's data is a decision a person makes with these counts in");
    out.push("  front of them - this tool will not make it for you.");
  } else {
    const state = report.schoolActive === false ? "INACTIVE" : "active";
    out.push(`School:  ${report.schoolName} (${report.schoolId}) - ${state}`);
  }

  out.push("");
  out.push("JDSmartLearn collections");
  out.push("");

  let totalRows = 0;
  let totalFiles = 0;
  let anyCapped = false;

  for (const c of report.counts) {
    totalRows += c.rows;
    totalFiles += c.files;
    anyCapped ||= c.capped;

    const count = c.capped ? `${n(c.rows)}+` : n(c.rows);
    const files = c.files > 0 ? `  ${padLeft(n(c.files), 6)} files` : pad("", 13);
    out.push(`  ${pad(c.collection, nameWidth)}  ${padLeft(count, 8)}${files}   ${c.holds}`);
  }

  out.push("");
  out.push(`  ${pad("TOTAL", nameWidth)}  ${padLeft(n(totalRows), 8)}  ${padLeft(n(totalFiles), 6)} files`);
  out.push("");

  if (anyCapped) {
    out.push("  A + means the scan stopped at --max, so that count is a floor.");
    out.push("  Re-run with a higher --max before treating any total as complete.");
    out.push("");
  }

  const unverifiable = report.counts.filter((c) => c.prefixedBySchool === false && c.files > 0);
  if (unverifiable.length) {
    out.push("Files that cannot be checked by prefix afterwards");
    out.push("");
    for (const c of unverifiable) {
      out.push(`  ${c.collection}: ${n(c.files)} object(s) under keys that do not start`);
      out.push(`  with the school. They delete correctly - the key comes from the`);
      out.push(`  document - but there is no prefix to list afterwards and confirm.`);
      out.push(`  New uploads are school-prefixed; these are historic.`);
    }
    out.push("");
  }

  out.push("Not counted here - ResultPeak deletes these");
  out.push("");
  for (const item of PURGED_BY_RESULTPEAK) {
    out.push(`  ${pad(item.collection, nameWidth)}  ${item.note}`);
  }
  out.push("");
  out.push(`Documents read: ${n(report.documentsRead)}.`);
  out.push("");

  return out;
}
