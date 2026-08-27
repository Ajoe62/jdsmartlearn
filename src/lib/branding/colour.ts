/**
 * A school's one colour, and whether it can carry text.
 *
 * NO "server-only" and no imports, deliberately - same treatment as
 * src/lib/auth/claims.ts and lib/branding/monogram.ts. It is called from the
 * settings write path AND from scripts/check-contrast.ts in CI, and those two
 * must be the same function. Two copies of a contrast test is how one of them
 * ends up weaker: that is the 2026-08-12 rules incident recorded in
 * docs/firestore-rules-to-append.md, in a different shape.
 *
 * See docs/SCHOOL-BRANDING.md section 5.
 */

/**
 * Must equal `ink` in tailwind.config.ts. scripts/check-contrast.ts asserts it,
 * because this module may not import the config - it has to stay dependency-free
 * so it can run anywhere - and a silently drifted value would mean the ratio we
 * promise an admin is not the ratio they get.
 */
export const INK = "#1A1C1F";
export const WHITE = "#FFFFFF";

/** WCAG AA for body text. A header band carries a school's name, so this is text. */
export const MIN_RATIO = 4.5;

/** Brand indigo, used whenever a school has set no colour. */
export const DEFAULT_BG = "#3852D6";

export type BrandColour = {
  /** The validated colour, always `#RRGGBB` uppercase. */
  bg: string;
  /** White or ink - COMPUTED from bg, never chosen by anyone. */
  fg: string;
  /** bg at low alpha, for a rule or a tint. Fill only, never behind text. */
  quiet: string;
  ratio: number;
};

export type ColourRefusal = {
  ok: false;
  /** Ready to show an admin. States the measured ratio - see the note below. */
  error: string;
  ratio: number | null;
};

export type ColourAccepted = { ok: true; colour: BrandColour };

/**
 * Brand indigo, resolved. Returns `BrandColour` rather than a result type, so
 * callers falling back after a refusal do not have to re-narrow a union that
 * cannot fail.
 */
export function defaultBrandColour(): BrandColour {
  const { fg, ratio } = bestForeground(DEFAULT_BG);
  return { bg: DEFAULT_BG, fg, quiet: tint(DEFAULT_BG), ratio };
}

/** `#abc`, `abc`, `#AABBCC` and `aabbcc` all normalise. Anything else is null. */
export function normaliseHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "");
  const expanded =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return /^[0-9a-fA-F]{6}$/.test(expanded) ? `#${expanded.toUpperCase()}` : null;
}

export function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * White or ink, whichever reads better on this background.
 *
 * Not a lightness threshold. A mid-yellow and a mid-blue can share a lightness
 * value and want opposite foregrounds, because luminance is weighted heavily
 * toward green - which is exactly the case a naive `L > 50 ? ink : white` gets
 * wrong, and exactly the palette a Nigerian school is likely to have.
 */
export function bestForeground(bg: string): { fg: string; ratio: number } {
  const onWhite = contrastRatio(bg, WHITE);
  const onInk = contrastRatio(bg, INK);
  return onWhite >= onInk ? { fg: WHITE, ratio: onWhite } : { fg: INK, ratio: onInk };
}

/** `#RRGGBBAA`. Eight-digit hex rather than rgba() so it drops straight into a token. */
export function tint(bg: string, alpha = 0.12): string {
  const byte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
  return `${bg}${byte}`;
}

/**
 * The whole rule, in one call.
 *
 * REFUSES rather than corrects, and that is the deliberate part. Silently
 * darkening a school's colour until it passes hands them a crest colour they did
 * not choose and cannot see is wrong; naming the measured ratio lets them pick a
 * darker shade of their own colour, or keep indigo. A school whose colour came
 * out unusable deserves to be told.
 *
 * An empty input is not an error - it is "no colour set", the state every school
 * starts in - so it returns the default rather than a refusal.
 */
export function assertBrandColour(input: string | null | undefined): ColourAccepted | ColourRefusal {
  if (input === null || input === undefined || input.trim() === "") {
    return { ok: true, colour: defaultBrandColour() };
  }

  const bg = normaliseHex(input);
  if (!bg) {
    return {
      ok: false,
      error: "Enter a colour as six hex digits, like #1B4D3E.",
      ratio: null,
    };
  }

  const { fg, ratio } = bestForeground(bg);
  if (ratio < MIN_RATIO) {
    return {
      ok: false,
      // The number is the useful part: it tells an admin how far off they are,
      // and a darker shade of the same colour usually clears it.
      error: `${bg} can't carry readable text - the best contrast available is ${ratio.toFixed(
        2
      )}:1 and ${MIN_RATIO}:1 is needed. Try a darker shade of the same colour.`,
      ratio,
    };
  }

  return { ok: true, colour: { bg, fg, quiet: tint(bg), ratio } };
}

/**
 * The CSS custom properties a resolved colour becomes.
 *
 * THREE TOKENS AND NO MORE. The school colour never becomes the action colour -
 * buttons stay brand indigo, because "only one thing per screen wears solid
 * blue" is what tells a teacher what to do next, and per-school that signal is
 * unlearnable for anyone who works at two schools. It never touches `warn`,
 * `danger` or `success` either: docs/ilumo-brand.md already puts those outside
 * the logo palette so a warning keeps reading as a warning, and that holds
 * harder when the borrowed colour belongs to a school.
 */
export function schoolCssVars(colour: BrandColour): string {
  return [
    `--school-bg:${colour.bg}`,
    `--school-fg:${colour.fg}`,
    `--school-quiet:${colour.quiet}`,
  ].join(";");
}

/**
 * Belt and braces before a value reaches a `<style>` element.
 *
 * Everything here is already produced by normaliseHex(), so this can only fail
 * if a future caller invents a value. It fails closed rather than escaping,
 * because there is no legitimate school colour that is not six hex digits.
 */
export function isSafeCssColour(value: string): boolean {
  return /^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(value);
}
