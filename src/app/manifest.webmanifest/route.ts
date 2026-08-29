import { NextResponse } from "next/server";
import { brandingSchoolId } from "@/lib/routing/request-school";
import { getSchoolBrand } from "@/lib/branding/school";

/**
 * The web app manifest, per school.
 *
 * Served from a route handler rather than `public/`, the same way
 * `src/app/sw.js/route.ts` is, and for a related reason: the contents depend on
 * the request. The static file this replaced named the product, so a child who
 * installed the app got a JDSmartLearn icon on their home screen - the most
 * permanent "you were handed off to somebody else" signal in the whole product,
 * and the one that sits on the phone for years.
 *
 * THE COOKIE IS THE ONLY INPUT AVAILABLE HERE, AND THAT IS ACCEPTABLE. A
 * manifest is fetched by the browser without credentials in some engines and
 * long before any session exists in all of them, so there is nothing else to
 * read. It only ever names a school and points at a public crest, which is the
 * same information the school prints on its own gate. Nothing personal, nothing
 * authorising: the rule that a signed-in surface must resolve its school from
 * the session is untouched, because this is not a signed-in surface.
 */

const PRODUCT = {
  name: "JDSmartLearn",
  short_name: "JDSmartLearn",
  description: "Read your lessons, with or without internet.",
} as const;

export async function GET() {
  const schoolId = await brandingSchoolId();
  const brand = schoolId ? await getSchoolBrand(schoolId) : null;

  /**
   * NO SCHOOL CREST AS AN INSTALLED ICON, and this is a known regression with a
   * named exit condition rather than an oversight.
   *
   * An installed icon has to be a square raster of at least 512px, or Android
   * renders a smudge. ResultPeak, which has owned the crest since 2026-08-29,
   * caps its data URI at 240px on the long edge - it is sized for a header and a
   * sign-in screen, and the cap is what keeps the projection small enough to
   * reach a phone on 3G. So no crest can currently satisfy the test, and
   * measuring one here would always fail.
   *
   * COST TODAY: ZERO SCHOOLS. Measured 2026-08-29 across the whole project, no
   * school had ever had an icon-eligible crest, so nothing regressed for anyone.
   * That number is also why this is not urgent for ResultPeak.
   *
   * EXIT: ResultPeak stores a square crest of at least 512px and adds the
   * eligibility flag to `schoolBranding/{id}`. Then this reads that flag and
   * points at /api/schools/{id}/logo, which already serves the bytes.
   *
   * Until then a school still gets its NAME on the home screen, which is most of
   * the win, with the product tile alongside it.
   */
  const icons = [
    { src: "/logo-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
    { src: "/logo-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ];

  const manifest = {
    name: brand?.name ?? PRODUCT.name,
    short_name: brand?.shortName ?? PRODUCT.short_name,
    description: brand
      ? `${brand.name} — read your lessons, with or without internet.`
      : PRODUCT.description,
    start_url: "/student",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F7F8FA",
    // The school's own colour tints the Android task switcher and status bar.
    // Always a validated hex - getSchoolBrand falls back to indigo.
    theme_color: brand?.colour.bg ?? "#3852D6",
    icons,
  };

  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      /**
       * Private, because the response names the school this device belongs to.
       * Short, because an admin who has just uploaded a crest should be able to
       * reinstall and see it rather than wait out a day.
       */
      "Cache-Control": "private, max-age=300",
    },
  });
}
