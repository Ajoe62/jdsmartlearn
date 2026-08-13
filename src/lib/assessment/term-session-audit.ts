/**
 * Which (term, session) pairs JDSmartLearn rows carry, and whether ResultPeak
 * has ever seen each one.
 *
 * PURE. No Firestore, no `server-only`, no `next/*`, for the same reason as
 * `ca.ts` and `projection.ts`: the caller passes in what it read, and this
 * decides only what to say about it. `scripts/diagnose-term-session.ts` does the
 * reading.
 *
 * WHY THIS EXISTS. ResultPeak joins a term's marks by exact string match, and is
 * gaining an end-of-session annual average computed from the three term
 * percentages. A pair that does not match does not error and does not blank the
 * report: the term simply drops out of the join and the annual figure still
 * prints a plausible number. Nobody upstream of a parent sees it happen. The
 * live data already contains the condition, so this is a report about something
 * that is true today, not a precaution.
 *
 * READ-ONLY, AND THE POINT IS THAT IT STAYS THAT WAY. This module names the
 * problem and never fixes it. Do not grow it a repair function, a normaliser, or
 * a "suggested value" that some later caller writes back. Deciding which of two
 * session strings a school's history should collapse onto is a decision about a
 * paying school's result sheets, and it is not JDSmartLearn's to take.
 *
 * NOTHING HERE KNOWS ABOUT ANNUAL AVERAGES. The annual figure, the term weights,
 * promotion marks and class position are ResultPeak's arithmetic. This module
 * counts strings; it never aggregates a mark, and it must never learn to.
 */

/** Where a pair was found. The JD half is what gets audited. */
export type JdSource = "assignments" | "submissions";

/**
 * Where ResultPeak carries a pair.
 *
 * `exams` and `results` are the join surface: those are the rows the annual
 * average is actually computed over. The school profile is a stated intention
 * rather than data that has joined to anything yet, which is why it is a source
 * of its own rather than being folded in with the other two. A pair matched only
 * there is matched against a school that says it is in that term, and against no
 * marks at all.
 */
export type RpSource = "exams" | "results" | "school profile";

/** One row as read, before anything is known about it. Term and session are `unknown`
 * on purpose: a row carrying a number, a null or nothing at all is a finding,
 * not something to skip past. */
export interface RawPair {
  term: unknown;
  session: unknown;
}

export interface JdRow extends RawPair {
  source: JdSource;
}

export interface RpRow extends RawPair {
  source: RpSource;
}

/**
 * A pair whose term or session is not a non-empty string.
 *
 * Its own category because ResultPeak's `getTermKey()` substitutes
 * "Unspecified Session" and "Unspecified Term" for a missing value rather than
 * failing, so such a row joins to a sheet nobody is looking at. It cannot be
 * compared byte for byte against anything, and calling it "unmatched" would
 * imply a string exists that could be corrected.
 */
export interface MalformedGroup {
  /** What was actually there, rendered for a human. */
  term: string;
  session: string;
  counts: Record<JdSource, number>;
  total: number;
}

/**
 * How an unmatched pair differs from a ResultPeak pair that is nearly it.
 *
 * DIAGNOSIS ONLY, PRODUCED AFTER THE MATCH HAS ALREADY BEEN DECIDED. The
 * comparison is byte for byte and stays that way; this exists because "unmatched"
 * on its own sends an operator hunting for a typo that is a single trailing
 * space. Nothing here changes a status, and no caller may treat a near miss as
 * a match.
 */
export interface NearMiss {
  /** The ResultPeak pair this one nearly is, rendered for display. */
  term: string;
  session: string;
  source: RpSource;
  /** What differs, in words: "trailing whitespace on the session", and so on. */
  differences: string[];
}

export interface AuditRow {
  /** Byte for byte as stored, rendered so invisible characters can be seen. */
  term: string;
  session: string;
  counts: Record<JdSource, number>;
  total: number;
  matched: boolean;
  /** Every ResultPeak source carrying this exact pair. Empty when unmatched. */
  matchedIn: RpSource[];
  /** Only ever populated when `matched` is false. */
  nearMisses: NearMiss[];
}

/**
 * One pair ResultPeak carries, and how many of its rows carry it.
 *
 * COUNTED, not merely listed. The list alone answers "what could a JDSmartLearn
 * row match", which is the question this file was built for. The counts answer
 * the one an operator asks next and cannot otherwise get: two pairs for the same
 * school, one with fifty rows and one with three, is the shape of the session
 * string defect, and it is visible in nothing but the counts.
 */
export interface RpPair {
  term: string;
  session: string;
  sources: RpSource[];
  counts: Record<RpSource, number>;
  total: number;
}

/**
 * One term ResultPeak carries under more than one session.
 *
 * A FINDING IN ITS OWN RIGHT, and not one JDSmartLearn caused. It is one term of
 * one school year already split across two result sheets, so whichever session a
 * JDSmartLearn row carries it can join to only one of them, and the annual
 * average is computed over only one of them too. A pre-pilot report that stayed
 * silent about it would pass a school whose marks are already divided.
 */
export interface SplitTerm {
  term: string;
  sessions: { session: string; total: number }[];
}

export interface AuditReport {
  rows: AuditRow[];
  malformed: MalformedGroup[];
  /** Every distinct pair ResultPeak carries, so an operator can see the target set. */
  resultPeakPairs: RpPair[];
  /** Terms ResultPeak carries under more than one session. Usually empty. */
  splitTerms: SplitTerm[];
  /** Totals, for the one line an operator reads first. */
  totals: { rows: number; pairs: number; unmatchedPairs: number; unmatchedRows: number };
}

/**
 * The key two pairs are compared on.
 *
 * `JSON.stringify` of the two strings, NOT `term + "|" + session`. A separator
 * character can appear inside a term or a session, and a session is free text in
 * ResultPeak, so a joined key can collide: `"a|b"` with `"c"` and `"a"` with
 * `"b|c"` produce the same string. A collision here would report a mismatched
 * pair as matched, which is the one wrong answer this whole file exists to
 * prevent. JSON escapes the quote and the backslash, so the encoding is
 * reversible and the key is unique.
 *
 * NO TRIMMING, NO CASE FOLDING, NO UNICODE NORMALISATION, deliberately and
 * permanently. A pair differing by one space is a different pair, because it is
 * a different result sheet.
 */
export function pairKey(term: string, session: string): string {
  return JSON.stringify([term, session]);
}

/**
 * Render a stored string so a human can see what is in it.
 *
 * FOR DISPLAY ONLY. Never feed the result of this back into a comparison. A
 * trailing space, a tab, a non-breaking space and a zero-width space all look
 * identical in a terminal, and each one is a separate result sheet in
 * ResultPeak. An operator asked to explain an unmatched pair cannot act on a
 * difference they cannot see.
 */
export function visible(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u00a0/g, "\\u00a0")
    .replace(/\u200b/g, "\\u200b")
    .replace(/\ufeff/g, "\\ufeff");
}

/** A value fit to be compared: a string with something in it. */
function usable(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** What a malformed value shows as. Distinguishes an empty string from a missing field. */
function renderMalformed(value: unknown): string {
  if (value === undefined) return "(field absent)";
  if (value === null) return "(null)";
  if (value === "") return "(empty string)";
  if (typeof value === "string") return visible(value);
  return `(${typeof value}: ${JSON.stringify(value)})`;
}

function emptyCounts(): Record<JdSource, number> {
  return { assignments: 0, submissions: 0 };
}

function emptyRpCounts(): Record<RpSource, number> {
  return { exams: 0, results: 0, "school profile": 0 };
}

/** The ResultPeak side mid-tally: the stored strings, not yet rendered for display. */
type RpPairTally = Omit<RpPair, "term" | "session"> & { term: string; session: string };

/**
 * Every way two nearly-equal strings differ, in words an operator can act on.
 *
 * Returns an empty list when the strings are equal or when the difference is not
 * one of these, which is what keeps a near miss narrow: two genuinely different
 * sessions are not each other's near miss just because they are both sessions.
 */
function differencesBetween(label: string, mine: string, theirs: string): string[] | null {
  if (mine === theirs) return [];

  const found: string[] = [];
  if (mine.trimStart() !== mine && mine.trimStart() === theirs.trimStart()) {
    found.push(`leading whitespace on the ${label}`);
  }
  if (mine.trimEnd() !== mine && mine.trimEnd() === theirs.trimEnd()) {
    found.push(`trailing whitespace on the ${label}`);
  }
  if (mine.trim().toLowerCase() === theirs.trim().toLowerCase() && mine.trim() !== theirs.trim()) {
    found.push(`different capitalisation in the ${label}`);
  }
  // A non-breaking space pasted from a spreadsheet is the classic one: it looks
  // exactly like a space and is a different sheet.
  const plain = (s: string) => s.replace(/[\u00a0\u200b\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  if (found.length === 0 && plain(mine) === plain(theirs)) {
    found.push(`invisible or repeated whitespace in the ${label}`);
  }

  return found.length > 0 ? found : null;
}

/**
 * ResultPeak pairs that differ from this one only in whitespace or case.
 *
 * Runs only for a pair already decided unmatched. Both halves must be either
 * equal or a recognised near miss, and at least one must actually differ, so a
 * pair does not become the near miss of every session in the school.
 */
function nearMissesFor(
  term: string,
  session: string,
  rpPairs: Map<string, RpPairTally>
): NearMiss[] {
  const out: NearMiss[] = [];
  for (const candidate of rpPairs.values()) {
    const termDiff = differencesBetween("term", term, candidate.term);
    const sessionDiff = differencesBetween("session", session, candidate.session);
    if (termDiff === null || sessionDiff === null) continue;
    const differences = [...termDiff, ...sessionDiff];
    if (differences.length === 0) continue; // identical, so not unmatched at all
    for (const source of candidate.sources) {
      out.push({
        term: visible(candidate.term),
        session: visible(candidate.session),
        source,
        differences,
      });
    }
  }
  return out;
}

/**
 * THE audit. Every distinct pair on JDSmartLearn rows, counted, and marked
 * matched or unmatched against what ResultPeak carries.
 *
 * Takes both sides as flat row lists rather than as pre-tallied maps, so the
 * caller cannot accidentally de-duplicate with a different rule than the one
 * used here. Counting is this function's job.
 */
export function auditTermSessions(jd: JdRow[], rp: RpRow[]): AuditReport {
  const rpPairs = new Map<string, RpPairTally>();
  for (const row of rp) {
    // A malformed ResultPeak row cannot be a match target. It is ResultPeak's
    // own data to fix, and this report is about JDSmartLearn's rows.
    if (!usable(row.term) || !usable(row.session)) continue;
    const key = pairKey(row.term, row.session);
    const entry =
      rpPairs.get(key) ??
      { term: row.term, session: row.session, sources: [], counts: emptyRpCounts(), total: 0 };
    if (!entry.sources.includes(row.source)) entry.sources.push(row.source);
    entry.counts[row.source] += 1;
    entry.total += 1;
    rpPairs.set(key, entry);
  }

  const tally = new Map<
    string,
    { term: string; session: string; counts: Record<JdSource, number>; total: number }
  >();
  const malformed = new Map<string, MalformedGroup>();

  for (const row of jd) {
    if (!usable(row.term) || !usable(row.session)) {
      const term = renderMalformed(row.term);
      const session = renderMalformed(row.session);
      const key = pairKey(term, session);
      const group =
        malformed.get(key) ?? { term, session, counts: emptyCounts(), total: 0 };
      group.counts[row.source] += 1;
      group.total += 1;
      malformed.set(key, group);
      continue;
    }

    const key = pairKey(row.term, row.session);
    const entry =
      tally.get(key) ?? { term: row.term, session: row.session, counts: emptyCounts(), total: 0 };
    entry.counts[row.source] += 1;
    entry.total += 1;
    tally.set(key, entry);
  }

  const rows: AuditRow[] = [...tally.values()].map((entry) => {
    const matchedIn = rpPairs.get(pairKey(entry.term, entry.session))?.sources ?? [];
    const matched = matchedIn.length > 0;
    return {
      term: visible(entry.term),
      session: visible(entry.session),
      counts: entry.counts,
      total: entry.total,
      matched,
      matchedIn: [...matchedIn],
      nearMisses: matched ? [] : nearMissesFor(entry.term, entry.session, rpPairs),
    };
  });

  // Unmatched first, then heaviest first: the row count is how many of a
  // school's marks are at stake, and that is the order to work in.
  rows.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? 1 : -1;
    if (a.total !== b.total) return b.total - a.total;
    return `${a.session} ${a.term}`.localeCompare(`${b.session} ${b.term}`);
  });

  const unmatched = rows.filter((r) => !r.matched);

  const resultPeakPairs = [...rpPairs.values()]
    .map((p) => ({ ...p, term: visible(p.term), session: visible(p.session) }))
    // Heaviest first. The defect this exists to expose looks like one pair with
    // most of the school's rows and a second with a handful, so the two want to
    // be adjacent and in that order.
    .sort((a, b) =>
      a.total === b.total
        ? `${a.session} ${a.term}`.localeCompare(`${b.session} ${b.term}`)
        : b.total - a.total
    );

  // Grouped on the term as stored, so two terms differing by a space are two
  // terms here as well. Splitting them would be a normalisation, and it would
  // hide a whitespace defect behind a session one.
  const bySession = new Map<string, { session: string; total: number }[]>();
  for (const pair of resultPeakPairs) {
    const sessions = bySession.get(pair.term) ?? [];
    sessions.push({ session: pair.session, total: pair.total });
    bySession.set(pair.term, sessions);
  }
  const splitTerms: SplitTerm[] = [...bySession.entries()]
    .filter(([, sessions]) => sessions.length > 1)
    .map(([term, sessions]) => ({ term, sessions }));

  return {
    rows,
    malformed: [...malformed.values()].sort((a, b) => b.total - a.total),
    resultPeakPairs,
    splitTerms,
    totals: {
      rows: jd.length,
      pairs: rows.length,
      unmatchedPairs: unmatched.length,
      unmatchedRows: unmatched.reduce((sum, r) => sum + r.total, 0),
    },
  };
}

/**
 * The report as lines of text.
 *
 * Pure, and separate from the script, so the wording is testable and the script
 * holds nothing but the reads. Quotes every string, because the quotes are what
 * make a trailing space visible at the end of a column.
 */
export function formatReport(report: AuditReport, schoolId: string): string[] {
  const lines: string[] = [];
  const pad = (value: string | number, width: number) => String(value).padStart(width);

  lines.push(`Term and session pairs on JDSmartLearn rows for school ${schoolId}`);
  lines.push("");
  lines.push(
    `  ${report.totals.rows} row(s) read, ${report.totals.pairs} distinct pair(s), ` +
      `${report.totals.unmatchedPairs} unmatched pair(s) covering ${report.totals.unmatchedRows} row(s).`
  );
  lines.push("");

  if (report.rows.length === 0) {
    lines.push("  No assignments or submissions carry a term and session yet.");
  }

  for (const row of report.rows) {
    const status = row.matched ? "matched  " : "UNMATCHED";
    lines.push(
      `  ${status}  ${pad(row.total, 5)} row(s)  ` +
        `(${pad(row.counts.assignments, 4)} assignment(s), ${pad(row.counts.submissions, 5)} submission(s))  ` +
        `"${row.term}" / "${row.session}"`
    );
    if (row.matched) {
      lines.push(`               in ResultPeak ${row.matchedIn.join(", ")}`);
      // A pair carried only by the school profile has joined to no marks. Worth
      // saying out loud: it is matched, and it is not yet evidence of anything.
      if (row.matchedIn.length === 1 && row.matchedIn[0] === "school profile") {
        lines.push(
          "               only the school profile states this pair. No exam or result carries it yet."
        );
      }
    } else {
      lines.push("               no exam, result or school profile in this school carries this pair.");
      for (const miss of row.nearMisses) {
        lines.push(
          `               nearly "${miss.term}" / "${miss.session}" (${miss.source}): ${miss.differences.join(", ")}`
        );
      }
    }
  }

  if (report.malformed.length > 0) {
    lines.push("");
    lines.push("  Rows with no usable term or session:");
    for (const group of report.malformed) {
      lines.push(
        `  MALFORMED  ${pad(group.total, 5)} row(s)  ` +
          `(${pad(group.counts.assignments, 4)} assignment(s), ${pad(group.counts.submissions, 5)} submission(s))  ` +
          `term ${group.term} / session ${group.session}`
      );
    }
    lines.push(
      "             ResultPeak substitutes \"Unspecified Term\" and \"Unspecified Session\" for these,"
    );
    lines.push("             so they join to a sheet nobody is looking at rather than failing.");
  }

  lines.push("");
  lines.push("  Pairs ResultPeak carries for this school:");
  if (report.resultPeakPairs.length === 0) {
    lines.push("    none. Every pair above is unmatched because there is nothing to match against.");
  }
  for (const pair of report.resultPeakPairs) {
    const where = pair.sources
      .map((source) =>
        source === "school profile"
          ? "stated on the school profile"
          : `${pair.counts[source]} ${source.slice(0, -1)}(s)`
      )
      .join(", ");
    lines.push(`    ${pad(pair.total, 5)} row(s)  "${pair.term}" / "${pair.session}"  (${where})`);
  }

  for (const split of report.splitTerms) {
    lines.push("");
    lines.push(
      `  SPLIT TERM. ResultPeak carries "${split.term}" under ${split.sessions.length} sessions: ` +
        split.sessions.map((s) => `"${s.session}" (${s.total} row(s))`).join(", ")
    );
    lines.push(
      "  That is one term of one school year already split across two result sheets, in"
    );
    lines.push(
      "  ResultPeak's own data. Whichever session a JDSmartLearn row carries, it can join to only"
    );
    lines.push("  one of them, and an annual average is computed over only one of them.");
  }

  return lines;
}
