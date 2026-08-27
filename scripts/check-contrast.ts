/**
 * Assert every foreground/background pair the interface actually uses meets
 * WCAG AA, reading the values from tailwind.config.ts rather than a copy.
 *
 * Contrast is the one part of a palette that cannot be judged by eye - the logo
 * mint reads "clearly visible" and is 1.52:1 on white, which is unreadable. The
 * ratios quoted in docs/ilumo-brand.md come from this script.
 *
 *   npx tsx scripts/check-contrast.ts
 */
import config from "../tailwind.config";
import {
  INK,
  MIN_RATIO,
  assertBrandColour,
  bestForeground,
  defaultBrandColour,
  normaliseHex,
} from "../src/lib/branding/colour";

const COLORS = (config.theme?.extend?.colors ?? {}) as Record<string, string>;

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function ratio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function hex(token: string): string {
  if (token === "white") return "#FFFFFF";
  const value = COLORS[token];
  if (!value) throw new Error(`check-contrast: no such token "${token}"`);
  return value;
}

/** [foreground, background, minimum, what it is]. 4.5 body text, 3.0 large/UI. */
const PAIRS: Array<[string, string, number, string]> = [
  // Body and secondary text on both page surfaces
  ["ink", "surface", 4.5, "body text on a card"],
  ["ink", "canvas", 4.5, "body text on the page"],
  ["muted", "surface", 4.5, "secondary text on a card"],
  ["muted", "canvas", 4.5, "secondary text on the page"],

  // Primary action, both directions
  ["white", "brand", 4.5, "primary button label"],
  ["white", "brandHover", 4.5, "primary button label, pressed"],
  ["brand", "surface", 4.5, "brand text"],
  ["brand", "brandSoft", 4.5, "brand text on its own tint"],

  // Links and information
  ["accentText", "surface", 4.5, "link text"],
  ["accentText", "canvas", 4.5, "link text on the page"],
  ["accentText", "accentSoft", 4.5, "info callout text"],
  ["white", "accentText", 4.5, "the 'ready to review' chip"],

  // Success. The mint fill carries ink, never white.
  ["ink", "success", 4.5, "the published chip"],
  ["successText", "surface", 4.5, "success text"],
  ["successText", "successSoft", 4.5, "success callout text"],

  // Status
  ["warn", "surface", 4.5, "warning text"],
  ["warn", "warnSoft", 4.5, "warning callout text"],
  ["danger", "surface", 4.5, "error text"],
  ["danger", "dangerSoft", 4.5, "error callout text"],

  /**
   * Non-text, WCAG 1.4.11: 3:1 for anything that identifies a control.
   *
   * Only `lineInput` is held to this. `line` and `lineStrong` are decorative -
   * card edges and dividers - and a separator carries no information a border
   * contrast requirement applies to. The input border does, on both surfaces it
   * can sit on.
   */
  ["lineInput", "surface", 3.0, "input border on a card"],
  ["lineInput", "canvas", 3.0, "input border on the page"],
  ["brand", "canvas", 3.0, "focus ring on the page"],
  ["brand", "surface", 3.0, "focus ring on a card"],
];

/**
 * Colours that are fills only. Asserted here as well as in check-tokens, so the
 * reason is recorded next to the arithmetic that proves it.
 */
const FILL_ONLY = ["accent", "success"];

let failures = 0;

console.log("Contrast against white, and in use:\n");
for (const [fg, bg, min, what] of PAIRS) {
  const value = ratio(hex(fg), hex(bg));
  const ok = value >= min;
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok" : "FAIL"}  ${value.toFixed(2).padStart(5)}:1  (min ${min})  ${fg} on ${bg} - ${what}`
  );
}

console.log("\nFill-only colours (must FAIL as text - that is the point):\n");
for (const token of FILL_ONLY) {
  const value = ratio(hex(token), hex("surface"));
  // If one of these ever passed, the palette drifted and the rule should go.
  const stillAFill = value < 4.5;
  if (!stillAFill) {
    failures++;
    console.log(`FAIL  ${token} is now ${value.toFixed(2)}:1 - it is no longer fill-only`);
  } else {
    console.log(`  ok  ${value.toFixed(2).padStart(5)}:1  ${token} - fill only, as documented`);
  }
}

/**
 * The per-school colour gate.
 *
 * A school's colour is the ONE colour in the product that is not in
 * tailwind.config, because it belongs to the school and is not known at build
 * time. So it cannot be checked as a pair above. What CAN be checked, and is
 * checked here, is that the function which admits or refuses it still behaves -
 * using the SAME function the write path calls, never a copy of the arithmetic.
 * Two copies of a contrast test is how one of them ends up weaker.
 *
 * See src/lib/branding/colour.ts and docs/SCHOOL-BRANDING.md section 5.
 */
console.log("\nPer-school colour (src/lib/branding/colour.ts):\n");

// The pure module may not import tailwind.config - it has to run anywhere - so
// its copy of `ink` is asserted against the real token here instead of drifting.
if (INK !== COLORS.ink) {
  failures++;
  console.log(`FAIL  branding/colour INK is ${INK} but the ink token is ${COLORS.ink}`);
} else {
  console.log(`  ok  INK matches the ink token (${INK})`);
}

// A school that has chosen nothing must still land on a readable pair.
const fallback = defaultBrandColour();
if (fallback.ratio < MIN_RATIO) {
  failures++;
  console.log(`FAIL  the default school colour is ${fallback.ratio.toFixed(2)}:1`);
} else {
  console.log(
    `  ok  ${fallback.ratio.toFixed(2).padStart(5)}:1  default (${fallback.bg} + computed ${fallback.fg})`
  );
}

/**
 * Colours a real Nigerian school might plausibly pick. Each asserts the
 * DECISION rather than a fixed ratio, so this keeps working if MIN_RATIO moves.
 *
 * THE INTERESTING RESULT, AND THE REASON bestForeground() IS NOT A LIGHTNESS
 * THRESHOLD: a bright school yellow is ACCEPTED. It is unreadable under white
 * and excellent under ink, and picking the better of the two is the whole job.
 * The logo mint is the same story at 11.21:1 - the very number
 * docs/ilumo-brand.md quotes for `ink on success`, arrived at independently
 * here, which is a useful cross-check that this module and the palette agree.
 *
 * What actually fails is the MIDDLE: a colour far enough from both ends to
 * carry neither. Those are the two below, and they are the cases a naive
 * "is it light or dark" test gets wrong in both directions.
 */
const SAMPLES: Array<[string, boolean, string]> = [
  ["#1B4D3E", true, "deep green"],
  ["#7A1F2B", true, "maroon"],
  ["#123B7A", true, "navy"],
  ["#000000", true, "black"],
  ["#FFFFFF", true, "white - carries ink"],
  ["#FFD400", true, "school yellow - carries ink, not white"],
  ["#5FE9B2", true, "logo mint - carries ink at 11.21:1"],
  ["#808080", false, "mid grey - carries neither"],
  ["#7D8471", false, "mid sage - the near-miss that looks fine"],
];

for (const [value, shouldPass, what] of SAMPLES) {
  const result = assertBrandColour(value);
  const { ratio } = bestForeground(normaliseHex(value) as string);
  if (result.ok !== shouldPass) {
    failures++;
    console.log(
      `FAIL  ${value} was ${result.ok ? "accepted" : "refused"} but should have been ${
        shouldPass ? "accepted" : "refused"
      } - ${what}`
    );
    continue;
  }
  console.log(
    `  ok  ${ratio.toFixed(2).padStart(5)}:1  ${value} ${
      result.ok ? "accepted" : "refused "
    } - ${what}`
  );
}

/**
 * A refusal has to be actionable. Naming the measured ratio is what lets an
 * admin pick a darker shade of their own colour; a bare "no" leaves them
 * guessing, which is how a school ends up with our indigo instead of theirs.
 */
const refused = assertBrandColour("#808080");
if (refused.ok || !/[0-9]\.[0-9][0-9]:1/.test(refused.error)) {
  failures++;
  console.log("FAIL  a refusal must quote the measured ratio");
} else {
  console.log("  ok  a refusal quotes the measured ratio");
}

// Garbage is refused, never coerced into something that happens to parse.
for (const bad of ["nope", "#12345", "rgb(1,2,3)", "#12345g"]) {
  if (assertBrandColour(bad).ok) {
    failures++;
    console.log(`FAIL  "${bad}" was accepted as a colour`);
  }
}

if (failures > 0) {
  console.error(`\ncheck-contrast: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\ncheck-contrast: OK - every pair meets AA.");
