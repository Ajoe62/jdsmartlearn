/**
 * Assert every colour utility in src/ resolves to a token in tailwind.config.ts.
 *
 * This exists because Tailwind class names are NOT typechecked. A stale
 * `bg-marker` after a token rename, or a typo like `text-mutd`, emits no CSS at
 * all - the element renders transparent or inherits, and the build passes
 * cleanly. Nothing else in the toolchain catches it, so this does.
 *
 * It also enforces the fill-only rule: `accent` and `success` are the logo
 * colours at logo brightness (2.86:1 and 1.52:1 on white) and must never be used
 * as a text colour. See docs/ilumo-brand.md section 3.
 *
 *   npx tsx scripts/check-tokens.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import config from "../tailwind.config";

const SRC = join(process.cwd(), "src");

/**
 * Tailwind prefixes that take a colour.
 *
 * `from`/`via`/`to` and `decoration` are deliberately absent: no gradient or
 * decoration colour is used anywhere here, and those three are ordinary English
 * words that match prose like "firestore-rules-to-append.md" constantly. Adding
 * them back means teaching the scanner to tell a class list from a sentence.
 */
const PREFIXES = [
  "bg", "text", "border", "ring", "fill", "stroke", "divide", "outline",
  "placeholder", "caret", "accent", "shadow",
];

/** Bare direction utilities - `border-b`, `divide-y` - carry no colour. */
const SIDES = new Set(["t", "r", "b", "l", "x", "y", "s", "e"]);

/**
 * Comments are prose and will match anything. Strip them before scanning, but
 * leave "https://" alone so a URL does not swallow the rest of its line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * Colours Tailwind ships that we still allow, plus the non-colour values these
 * prefixes also accept (`text-sm`, `border-2`, `shadow-card`...). Anything that
 * is not a known token and not in here is reported.
 */
const BUILT_IN = new Set(["white", "black", "transparent", "current", "inherit"]);

function tokens(): Set<string> {
  const colors = (config.theme?.extend?.colors ?? {}) as Record<string, string>;
  return new Set(Object.keys(colors));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const KNOWN = tokens();

// Non-colour scales these prefixes share, which must not be reported as typos.
const NOT_A_COLOUR =
  /^(xs|sm|base|lg|xl|[0-9]|[0-9]\.5|[0-9]{1,3}|none|full|auto|left|right|center|justify|start|end|solid|dashed|dotted|double|hidden|wrap|nowrap|balance|pretty|ellipsis|clip|display|title|heading|subheading|eyebrow|readable|app|card|lift|brand|tabular|\[.*\])$/;

const problems: string[] = [];
const fillOnly: string[] = [];

for (const file of walk(SRC)) {
  const source = stripComments(readFileSync(file, "utf8"));
  const lines = source.split("\n");

  lines.forEach((line, i) => {
    for (const prefix of PREFIXES) {
      // Matches bg-x, hover:bg-x, sm:focus-visible:bg-x, border-t-x, ...
      const re = new RegExp(`\\b${prefix}(?:-[trblxyse])?-([A-Za-z][A-Za-z0-9]*)\\b`, "g");
      for (const match of line.matchAll(re)) {
        const value = match[1];
        // `border-b` and friends: the match captured the side, not a colour.
        if (SIDES.has(value)) continue;
        if (KNOWN.has(value) || BUILT_IN.has(value) || NOT_A_COLOUR.test(value)) {
          // Fill-only colours must never carry text.
          if ((value === "accent" || value === "success") && prefix === "text") {
            fillOnly.push(
              `${file}:${i + 1}  text-${value} - use text-${value}Text (${value} is a fill, ` +
                `${value === "accent" ? "2.86" : "1.52"}:1 on white)`
            );
          }
          continue;
        }
        problems.push(`${file}:${i + 1}  ${match[0]} - "${value}" is not a token`);
      }
    }
  });
}

if (fillOnly.length > 0) {
  console.error("Fill-only colour used as text:\n" + fillOnly.join("\n") + "\n");
}
if (problems.length > 0) {
  console.error("Unknown colour tokens (these emit NO CSS):\n" + problems.join("\n") + "\n");
}

if (problems.length > 0 || fillOnly.length > 0) {
  console.error(`check-tokens: ${problems.length + fillOnly.length} problem(s).`);
  process.exit(1);
}

console.log(`check-tokens: OK - every colour utility resolves (${KNOWN.size} tokens).`);
