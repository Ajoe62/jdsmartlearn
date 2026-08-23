/**
 * Student JavaScript budget.
 *
 *   npm run check:budget          (after `npm run build`)
 *
 * CLAUDE.md, Offline rules: "student-route app JS stays under 30 KB gzipped".
 * That rule shipped with the offline work and was never enforced, so it drifted
 * unchecked for a month. This is the enforcement.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT THE NUMBER NEXT BUILD PRINTS.
 * `next build` reports "First Load JS", which INCLUDES the React and Next
 * runtime - about 100 KB that every page in every Next app carries and that no
 * amount of care in this repo can remove. Holding a page to 30 KB against that
 * baseline would fail on an empty page, and a check that can never pass gets
 * deleted rather than fixed.
 *
 * So this measures the APP CODE: each student route's own chunks, minus the
 * chunks shared with every other route. That is the part this codebase writes
 * and the part a careless import actually grows.
 *
 * MEASURED GZIPPED, because a student is on a throttled 3G link and gzip is what
 * travels. Raw bytes would be roughly three times the number that matters.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** CLAUDE.md, Offline rules. Do not raise this to make a build pass. */
const BUDGET_BYTES = 30 * 1024;

/**
 * Routes held to the budget: everything a signed-in student can reach.
 *
 * Keys are as the MANIFEST spells them - route group included, `/page`
 * suffixed. Written out rather than derived from the URL, because the mapping
 * from one to the other is Next's business and guessing it is how this check
 * would quietly start measuring nothing.
 *
 * `/student/sign-in` is deliberately absent. It is the one student page that
 * runs before the service worker is installed, it is visited once per device,
 * and it carries the Firebase client for the access-code check - which is the
 * single biggest import in the app and cannot be removed from it.
 */
const STUDENT_ROUTES = [
  "/(student)/student/page",
  "/(student)/student/lessons/[id]/page",
  "/(student)/student/subjects/[subjectId]/page",
  "/(student)/student/schemes/[schemeId]/page",
  "/(student)/student/assignments/page",
  "/(student)/student/assignments/[assignmentId]/page",
  "/(student)/student/progress/page",
  "/(student)/student/offline/page",
];

/** Strip the manifest's scaffolding so the report reads like a URL. */
function displayName(key: string): string {
  return key.replace(/^\/\([^)]+\)/, "").replace(/\/page$/, "") || "/";
}

const BUILD = path.join(process.cwd(), ".next");

interface Manifest {
  pages: Record<string, string[]>;
}

function loadManifest(): Manifest {
  const file = path.join(BUILD, "app-build-manifest.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    console.error(
      "check:budget: no .next/app-build-manifest.json.\n" +
        "Run `npm run build` first - this measures the real build output, not the source."
    );
    process.exit(1);
  }
}

function gzippedSize(chunk: string): number {
  const file = path.join(BUILD, chunk);
  try {
    if (!statSync(file).isFile()) return 0;
    return gzipSync(readFileSync(file)).length;
  } catch {
    return 0;
  }
}

/**
 * Chunks present on EVERY route are framework and shared runtime, not this
 * page's app code. Computed rather than hardcoded so a Next upgrade that renames
 * its chunks does not silently start counting them.
 */
function sharedChunks(manifest: Manifest): Set<string> {
  const routes = Object.keys(manifest.pages);
  if (routes.length === 0) return new Set();

  let shared = new Set(manifest.pages[routes[0]] ?? []);
  for (const route of routes.slice(1)) {
    const chunks = new Set(manifest.pages[route] ?? []);
    shared = new Set([...shared].filter((c) => chunks.has(c)));
  }
  return shared;
}

function main(): void {
  const manifest = loadManifest();
  const shared = sharedChunks(manifest);

  const rows: { route: string; bytes: number; over: boolean }[] = [];
  const missing: string[] = [];

  for (const route of STUDENT_ROUTES) {
    const chunks = manifest.pages[route];
    if (!chunks) {
      missing.push(route);
      continue;
    }
    const bytes = chunks
      .filter((c) => !shared.has(c))
      .reduce((total, c) => total + gzippedSize(c), 0);
    rows.push({ route: displayName(route), bytes, over: bytes > BUDGET_BYTES });
  }

  const width = Math.max(...rows.map((r) => r.route.length), 10);
  console.log(`\nStudent JS budget: ${(BUDGET_BYTES / 1024).toFixed(0)} KB gzipped per route`);
  console.log(`(app code only - ${shared.size} shared framework chunk(s) excluded)\n`);

  for (const row of rows.sort((a, b) => b.bytes - a.bytes)) {
    const kb = (row.bytes / 1024).toFixed(1).padStart(6);
    console.log(`  ${row.over ? "OVER" : "ok  "}  ${kb} KB  ${row.route.padEnd(width)}`);
  }

  /**
   * A route in the list that the build did not produce is a FAILURE, not a
   * skip. It means a student page was renamed or deleted and this list was not
   * updated - which would silently stop measuring it.
   */
  if (missing.length > 0) {
    console.error(
      `\ncheck:budget: FAILED - these routes are in STUDENT_ROUTES but not in the build:\n` +
        missing.map((r) => `  ${r}`).join("\n") +
        `\nUpdate the list in scripts/check-budget.ts, or restore the route.`
    );
    process.exit(1);
  }

  const over = rows.filter((r) => r.over);
  if (over.length > 0) {
    console.error(
      `\ncheck:budget: FAILED - ${over.length} route(s) over budget.\n` +
        `A student is on a mid-range Android phone on throttled 3G. Find the new\n` +
        `import: a client component pulled into a server page is the usual cause.\n` +
        `Do not raise BUDGET_BYTES to make this pass - the rule is in CLAUDE.md.`
    );
    process.exit(1);
  }

  console.log("\ncheck:budget: OK - every student route is inside the budget.");
}

main();
