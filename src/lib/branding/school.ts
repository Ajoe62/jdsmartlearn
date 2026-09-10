import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { RP } from "@/lib/db/collections";
import { canonicalSchoolSlug } from "@/lib/db/resultpeak";
import { assertBrandColour, defaultBrandColour, type BrandColour } from "./colour";
import {
  crestUrlFor,
  decodeCrestDataUri,
  isSafeCrestUrl,
  type DecodedCrest,
} from "./crest";
import { monogram, shortenSchoolName } from "./monogram";
import { isSafePartnerOrigin } from "@/lib/partner-links";

/**
 * THE ONLY read of a school's branding for display. Nothing else in the codebase
 * may read a school's branding or its name in order to render it.
 *
 * ============================================================================
 * RESULTPEAK OWNS BRANDING. DECIDED 2026-08-29. THIS REPO READS AND NEVER
 * WRITES.
 * ============================================================================
 *
 * `schools/{id}.branding` is the source of truth over there;
 * `schoolBranding/{id}` is its public projection, written by exactly one writer
 * in that repo immediately after the school saves. This repo reads THE
 * PROJECTION, for three reasons:
 *
 *   - It is the smaller document, and it is the one ResultPeak's own signed-out
 *     client reads. Reading the same record is what stops the two products
 *     describing one school differently.
 *   - It carries `logoUpdatedAt`, which moves ONLY when the crest bytes move.
 *     That is the cache key the crest route needs; the source document has no
 *     equivalent.
 *   - It carries the motto, so there is nothing left that needs the source.
 *
 * `schools/{id}` is still read, for `name` and `isActive` only. Two document
 * reads per school per 15 minutes, unchanged.
 *
 * A MISSING PROJECTION IS A REAL STATE, NOT A GAP. ResultPeak deletes
 * `schoolBranding/{id}` as a stage of its school-purge cascade, so absent means
 * "this school is gone". The school resolves to null and callers render the
 * plain product lockup - never a stale crest.
 *
 * The previous arrangement, where this repo held its own record in
 * `jdSchoolSettings` and its own crest in R2, is gone. No school had ever used
 * it: measured 2026-08-29, zero crests in R2, zero `logoIsIcon`, and no
 * `branding` map on any settings document.
 *
 * See docs/SCHOOL-BRANDING.md and docs/school-addresses.md.
 */

/**
 * `schoolBranding/{schoolId}`, as ResultPeak writes it.
 *
 * Every field is optional here even though ResultPeak writes them all: this is
 * another product's document, and a reader that assumes a field exists breaks
 * the day that product ships a new version first.
 */
interface PublicBranding {
  displayName?: string;
  logoUrl?: string;
  /** Usually "". Set only when a school's favicon DIFFERS from its crest. */
  faviconUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  motto?: string;
  /** Moves only when the crest bytes change. `0` is a real value, not "unknown". */
  logoUpdatedAt?: number;
  /** Moves on every save of anything. NEVER key a cache on this. */
  updatedAt?: number;
  /**
   * The school's OWN ResultPeak origin (`https://host`, no path), for a school
   * that runs its results service on a domain of its own.
   *
   * ABSENT OR "" IS THE NORMAL CASE, not a gap to backfill: most schools have no
   * domain and land on the shared deployment through
   * NEXT_PUBLIC_RESULTPEAK_URL. Surfaced on SchoolBrand below and used only
   * through src/lib/partner-links.ts, which re-validates it.
   */
  resultsUrl?: string;
  /**
   * The school's own JDSmartLearn origin. READ AND DELIBERATELY NOT SURFACED:
   * this repo IS lessons, and a link from a school's own JDSmartLearn domain
   * back to a JDSmartLearn origin is either a link to the current page or a
   * link that moves a signed-in child off their own session's host. It is
   * declared so the field is documented where it is read rather than looking
   * like something ResultPeak forgot to send.
   */
  lessonsUrl?: string;
}

/** What a header, a front door or a sign-in screen needs. Never personal data. */
export interface SchoolBrand {
  schoolId: string;
  /** ResultPeak's, verbatim. Never normalised. */
  name: string;
  /** Fits a 360px header. Falls back to a trimmed `name`. */
  shortName: string;
  /** Two letters. Shown whenever there is no crest. */
  initials: string;
  /**
   * Our own same-origin route, versioned by `logoUpdatedAt`. Null when the
   * school has no crest.
   *
   * DELIBERATELY NOT THE DATA URI ITSELF, and this is the one place the two
   * products' shapes are not simply copied. ResultPeak's crest is 77 to 81 KB of
   * base64 on the projection. That is fine in a document and fine in IndexedDB,
   * and it is NOT fine inside /api/student/sync, whose ETag hashes the whole
   * response body: one tutor publishing one lesson would cost every child in the
   * class a fresh 81 KB over 3G for a picture that had not changed. A ~50 byte
   * versioned URL keeps the crest out of that body, and the service worker
   * already caches this path.
   */
  crestUrl: string | null;
  /** Shown on the school front door only. Never in the header. */
  motto: string | null;
  /** Always resolved - falls back to brand indigo. `fg` is computed, never chosen. */
  colour: BrandColour;
  /**
   * The /s/{slug} link a school prints. RESULTPEAK'S STORED SLUG when it has
   * one, derived from the name only when it has not.
   *
   * THIS IS THE ONE THAT REACHES PAPER - printableSchoolAddress() puts it on
   * every class sign-in sheet - and the one that builds the outbound link to
   * ResultPeak. Deriving it over a stored value printed an address that landed
   * on this side's own school picker. See canonicalSchoolSlug().
   */
  slug: string;
  /**
   * The school's own ResultPeak origin, or null - which is the common case and
   * means "use the shared deployment", never "this school has no results".
   *
   * Validated to a bare https origin on read (see isSafePartnerOrigin), so a
   * caller may put it straight into an href. Pass it to the partner-links
   * helpers rather than joining a path onto it here: a school's own hostname
   * already names the school, so those helpers drop the /s/{slug} segment that
   * the shared deployment needs.
   */
  resultsUrl: string | null;
}

/** Invalidated when branding changes, so a crest edit is not 15 minutes late. */
export function schoolBrandTag(schoolId: string): string {
  return `school-brand:${schoolId}`;
}

export function revalidateSchoolBrand(schoolId: string): void {
  revalidateTag(schoolBrandTag(schoolId));
}

/**
 * DELIBERATELY NOT CALLING getSchool(), AND THAT IS THE WHOLE POINT.
 *
 * lib/db/resultpeak.ts carries an explicit warning that getSchool() must never
 * be cached: three callers re-read `assessmentTypes` precisely because a school
 * admin can drop an assessment type after scores exist, and a cache there would
 * put a staleness window in front of a decision about a real child's marks.
 *
 * So this reads the documents directly and caches ONLY THE PROJECTION BELOW -
 * exactly the pattern getSubjectAllocationEnforced() established. The invariant
 * is that only the named fields of SchoolBrand cross the cache boundary, so no
 * cached object anywhere holds `assessmentTypes` for a future caller to find.
 *
 * Returns null for a school that does not exist, is inactive, or has been
 * purged. Callers render the plain product lockup then.
 */
export function getSchoolBrand(schoolId: string): Promise<SchoolBrand | null> {
  if (!schoolId) return Promise.resolve(null);

  return unstable_cache(
    async (): Promise<SchoolBrand | null> => {
      const [schoolSnap, brandingSnap] = await Promise.all([
        adminDb.doc(`${RP.schools}/${schoolId}`).get(),
        adminDb.doc(`${RP.schoolBranding}/${schoolId}`).get(),
      ]);

      if (!schoolSnap.exists) return null;

      // Strict !== false: absent means active, matching every other read of this
      // field in the codebase.
      if (schoolSnap.get("isActive") === false) return null;

      const name = schoolSnap.get("name");
      if (typeof name !== "string" || !name.trim()) return null;

      const branding: PublicBranding = brandingSnap.exists
        ? ((brandingSnap.data() ?? {}) as PublicBranding)
        : {};

      /**
       * Re-validated on READ, not trusted from the document.
       *
       * ResultPeak validates on write and again when it projects, but a value
       * can predate a rule or be edited in the Firebase console, and this is the
       * last point before it becomes CSS. A refusal falls back to indigo rather
       * than throwing: a bad colour must never take down every page in a school.
       */
      const checked = assertBrandColour(branding.primaryColor?.trim() || null);
      const colour = checked.ok ? checked.colour : defaultBrandColour();

      /**
       * `faviconUrl || logoUrl`, as ResultPeak specifies. faviconUrl is "" for
       * almost every school on purpose: storing the crest in both fields once
       * produced a 155 KB document, and this record reaches a phone on 3G.
       *
       * `isSafeCrestUrl` still guards it. The value comes from another product's
       * document and ends up in an `img src`; SVG stays refused, because an SVG
       * is a document that can carry script.
       */
      const rawCrest = branding.faviconUrl?.trim() || branding.logoUrl?.trim() || "";
      const hasCrest = isSafeCrestUrl(rawCrest);

      /**
       * `logoUpdatedAt` is `0` for every school today, and that is a STABLE key
       * rather than a missing one: a crest can only change through a profile
       * save, and that save stamps the field. Treat 0 as a legitimate value and
       * never as "unknown", or every page load busts the crest cache.
       */
      const version = Number(branding.logoUpdatedAt ?? 0) || 0;

      /**
       * Re-validated on read, for the same reason the colour is: it arrives from
       * another product's document and ends up in an href a child clicks. A
       * value that is not a bare https origin resolves to null, and every link
       * falls back to the shared deployment rather than disappearing.
       */
      const ownResults = branding.resultsUrl?.trim() || "";

      return {
        schoolId,
        name,
        shortName: branding.displayName?.trim() || shortenSchoolName(name),
        initials: monogram(name),
        crestUrl: hasCrest ? crestUrlFor(schoolId, version) : null,
        motto: branding.motto?.trim() || null,
        colour,
        // ResultPeak's stored slug. Free: `schools/{id}` is already read above.
        slug: canonicalSchoolSlug(schoolSnap.get("slug"), name),
        resultsUrl: isSafePartnerOrigin(ownResults) ? ownResults : null,
      };
    },
    ["school-brand", schoolId],
    { revalidate: 900, tags: [schoolBrandTag(schoolId)] }
  )();
}

/**
 * The crest bytes behind /api/schools/{id}/logo.
 *
 * SEPARATE FROM getSchoolBrand ON PURPOSE, and it stays separate now for the
 * opposite reason it used to. It once existed to keep an R2 storage key off any
 * rendered payload. There is no key any more; what it keeps off the payload is
 * 81 KB of base64, which must not ride inside the ETag'd /api/student/sync body.
 *
 * Decodes the data URI here, server-side, so the route serves ordinary image
 * bytes with an ordinary Content-Type. The browser gets a normal cacheable
 * image, the service worker caches it as one, and a data URI never reaches a
 * student device at all.
 *
 * An https crest (a school pointing at an image it already hosts) is NOT fetched
 * and proxied. Returning null makes the route 404 and the page falls back to the
 * monogram. Fetching an arbitrary URL from a Firestore document, server-side,
 * would be a request forgery primitive pointed at whatever an admin typed.
 */
export function getSchoolCrest(schoolId: string): Promise<DecodedCrest | null> {
  if (!schoolId) return Promise.resolve(null);

  return unstable_cache(
    async (): Promise<DecodedCrest | null> => {
      const [schoolSnap, brandingSnap] = await Promise.all([
        adminDb.doc(`${RP.schools}/${schoolId}`).get(),
        adminDb.doc(`${RP.schoolBranding}/${schoolId}`).get(),
      ]);

      if (!schoolSnap.exists || schoolSnap.get("isActive") === false) return null;
      if (!brandingSnap.exists) return null;

      const branding = (brandingSnap.data() ?? {}) as PublicBranding;
      const raw = branding.faviconUrl?.trim() || branding.logoUrl?.trim() || "";
      if (!isSafeCrestUrl(raw)) return null;

      return decodeCrestDataUri(raw);
    },
    ["school-crest", schoolId],
    { revalidate: 900, tags: [schoolBrandTag(schoolId)] }
  )();
}
