import { NextResponse } from "next/server";
import { getBrandingSchoolId } from "@/lib/auth/student";
import { getSchoolBrand } from "@/lib/branding/school";
import { getSchoolBranding } from "@/lib/db/school-branding";

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
  const schoolId = await getBrandingSchoolId();
  const brand = schoolId ? await getSchoolBrand(schoolId) : null;

  /**
   * The crest becomes the installed icon only when it is a square PNG of at
   * least 512px - measured once at upload, never here. An SVG cannot serve as
   * an Android maskable icon, and a letterboxed logo at 192px is a smudge.
   *
   * A school that fails that test still gets its NAME on the home screen, which
   * is most of the win, with the product tile alongside it.
   */
  const branding = schoolId && brand ? await getSchoolBranding(schoolId) : null;
  const crestIsIcon = !!(branding?.logoIsIcon && brand?.crestUrl);

  const icons = [
    ...(crestIsIcon
      ? [
          {
            src: brand!.crestUrl!,
            sizes: "512x512",
            type: "image/png",
            // "any" only. A crest is not designed for a maskable safe zone, and
            // declaring it maskable would let Android crop the school's name off.
            purpose: "any",
          },
        ]
      : []),
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
