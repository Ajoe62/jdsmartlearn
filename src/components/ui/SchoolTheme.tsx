import { isSafeCssColour, schoolCssVars } from "@/lib/branding/colour";
import type { SchoolBrand } from "@/lib/branding/school";

/**
 * The school's colour, as three CSS custom properties on `:root`.
 *
 * A `<style>` element rather than a wrapper `<div>`: the variables have to reach
 * the sticky header, the page and anything portalled, and a wrapper would either
 * break `min-h-dvh` or need `display: contents`, which has its own accessibility
 * footguns. This is one line of CSS and no DOM.
 *
 * SERVER-RENDERED, WITH NO CLIENT JAVASCRIPT. That is what keeps per-school
 * theming free against the 30 KB student route budget - a runtime theme provider
 * would cost more than the entire feature is worth.
 *
 * THREE TOKENS AND NO MORE. `--school-bg`, `--school-fg` and `--school-quiet`.
 * The school colour never becomes the action colour and never touches a status
 * colour; the reasoning is in lib/branding/colour and in docs/ilumo-brand.md.
 */
export default function SchoolTheme({ brand }: { brand: SchoolBrand | null }) {
  if (!brand) return null;

  const { bg, fg, quiet } = brand.colour;

  /**
   * Fails closed. Every value here came from normaliseHex() upstream, so this
   * can only trip if a future caller invents one - and there is no legitimate
   * school colour that is not six hex digits. Rendering nothing falls back to
   * the token defaults in tailwind.config, which is indigo.
   */
  if (![bg, fg, quiet].every(isSafeCssColour)) return null;

  return (
    /* Three hex values, every one of them checked against
       /^#[0-9A-F]{6,8}$/ immediately above and dropped entirely if any fails.
       Nothing here is ever user text. */
    <style dangerouslySetInnerHTML={{ __html: `:root{${schoolCssVars(brand.colour)}}` }} />
  );
}
