import { isSafeCssColour } from "./colour";
import type { OfflineBrand } from "@/lib/offline/db";

/**
 * Re-apply a school's colour on the client, from the device store.
 *
 * WHY THIS EXISTS AT ALL. `<SchoolTheme />` server-renders the same three
 * variables, and on every online page load that is the whole story. But the
 * service worker serves ONE cached HTML document for any `/student/*`
 * navigation it cannot fetch, and that document carries whatever `<style>` was
 * current when it was cached. So on a dead link the colours could be a
 * deployment behind - or, on a phone whose shell was cached before anyone
 * signed in, absent entirely.
 *
 * This is the correction, and it is deliberately tiny: three custom properties
 * set on the document element, no DOM built, no component re-rendered, a few
 * hundred bytes against the 30 KB student route budget.
 *
 * It does NOT rewrite the header's text or crest. Those are server-rendered
 * markup, and reaching into them from JavaScript to swap a school name would be
 * a second rendering path for the same thing - the exact duplication CLAUDE.md
 * forbids for student views. The cached shell self-corrects instead: signing in
 * purges every cache (wipeDevice) and shellFirst re-fetches the shell on each
 * navigation, so a school change cannot leave stale chrome behind.
 */
export function applySchoolColour(brand: OfflineBrand | undefined): void {
  if (typeof document === "undefined" || !brand) return;

  // Fails closed. Everything here came from assertBrandColour on the server, so
  // this can only trip on a store written by something that bypassed it.
  if (![brand.bg, brand.fg, brand.quiet].every(isSafeCssColour)) return;

  const root = document.documentElement;
  root.style.setProperty("--school-bg", brand.bg);
  root.style.setProperty("--school-fg", brand.fg);
  root.style.setProperty("--school-quiet", brand.quiet);
}
