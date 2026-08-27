import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP } from "@/lib/db/collections";
import { schoolSlug } from "@/lib/db/resultpeak";
import { EMPTY_BRANDING, type SchoolBranding } from "@/lib/db/school-branding";
import { assertBrandColour, defaultBrandColour, type BrandColour } from "./colour";
import { monogram, shortenSchoolName } from "./monogram";

/**
 * THE ONLY read of a school's branding for display. Nothing else in the codebase
 * may read `jdSchoolSettings/{id}.branding` or a school's name to render it.
 *
 * Same shape and the same reason as getCurrentTermSession() in
 * lib/db/school-settings.ts: ResultPeak stores no crest, no colour and no
 * stable slug today, so JDSmartLearn holds them. When ResultPeak ships
 * `schools/{id}.branding` (docs/resultpeak-school-branding-prompt.md), the
 * resolution order below gains one line and NOTHING ELSE IN THE CODEBASE
 * CHANGES.
 *
 * See docs/SCHOOL-BRANDING.md.
 */

/** What a header, a front door or a sign-in screen needs. Never personal data. */
export interface SchoolBrand {
  schoolId: string;
  /** ResultPeak's, verbatim. Never normalised. */
  name: string;
  /** Fits a 360px header. Falls back to a trimmed `name`. */
  shortName: string;
  /** Two letters. Shown whenever there is no crest. */
  initials: string;
  /** Our own authenticated-adjacent route, versioned. Null when none uploaded. */
  crestUrl: string | null;
  /** Shown on the school front door only. Never in the header. */
  motto: string | null;
  /** Always resolved - falls back to brand indigo. `fg` is computed, never chosen. */
  colour: BrandColour;
  /** The /s/{slug} link a school prints. Derived until ResultPeak stores one. */
  slug: string;
}

/** Invalidated when an admin saves branding, so a crest change is not 15 minutes late. */
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
 * exactly the pattern getSubjectAllocationEnforced() established. There is no
 * field mask, and reaching for one would be a mistake: `select()` is a Query
 * method rather than a DocumentReference method, and it was never the safety
 * property anyway. The invariant is that only the named fields of SchoolBrand
 * cross the cache boundary, so no cached object anywhere holds `assessmentTypes`
 * for a future caller to find. Projecting on the way out delivers that however
 * the document was fetched.
 *
 * Cost: two document reads per school per 15 minutes, however many people are
 * signed in - and the tag above collapses the wait to zero on an actual edit.
 *
 * Returns null for a school that does not exist or is inactive. Callers render
 * the plain product lockup then: a pinned cookie is attacker-supplied and may
 * name anything at all.
 */
export function getSchoolBrand(schoolId: string): Promise<SchoolBrand | null> {
  if (!schoolId) return Promise.resolve(null);

  return unstable_cache(
    async (): Promise<SchoolBrand | null> => {
      const [schoolSnap, settingsSnap] = await Promise.all([
        adminDb.doc(`${RP.schools}/${schoolId}`).get(),
        adminDb.doc(`${JD.schoolSettings}/${schoolId}`).get(),
      ]);

      if (!schoolSnap.exists) return null;

      // Strict !== false: absent means active, matching every other read of this
      // field in the codebase.
      if (schoolSnap.get("isActive") === false) return null;

      const name = schoolSnap.get("name");
      if (typeof name !== "string" || !name.trim()) return null;

      /**
       * Resolution order, and the only lines that change when ResultPeak ships
       * its own record:
       *
       *   1. jdSchoolSettings/{id}.branding   <- today's source, JD-owned
       *   2. schools/{id}.branding            <- preferred once it exists
       *   3. derived                          <- never blank
       */
      const branding: SchoolBranding = {
        ...EMPTY_BRANDING,
        ...((settingsSnap.get("branding") ?? {}) as Partial<SchoolBranding>),
      };

      const shortName = branding.shortName?.trim() || shortenSchoolName(name);

      /**
       * Re-validated on READ, not trusted from the document.
       *
       * The write path validates too, but a value can predate a rule, arrive
       * from a future ResultPeak field, or be edited in the Firebase console.
       * A refusal here falls back to indigo rather than throwing: a bad colour
       * must never be able to take down every page in a school.
       */
      const checked = assertBrandColour(branding.colorHex);
      const colour = checked.ok ? checked.colour : defaultBrandColour();

      return {
        schoolId,
        name,
        shortName,
        initials: monogram(name),
        crestUrl:
          branding.logoKey && branding.logoUpdatedAt
            ? `/api/schools/${encodeURIComponent(schoolId)}/logo?v=${branding.logoUpdatedAt}`
            : null,
        motto: branding.motto?.trim() || null,
        colour,
        slug: schoolSlug(name),
      };
    },
    ["school-brand", schoolId],
    { revalidate: 900, tags: [schoolBrandTag(schoolId)] }
  )();
}

/**
 * The storage key behind a school's crest, for the serving route only.
 *
 * SEPARATE FROM getSchoolBrand ON PURPOSE. The R2 key must never leave the
 * server - a key on a client payload is a public bucket URL by another name
 * (CLAUDE.md, file storage) - so it is not a field on SchoolBrand and cannot be
 * reached from anything that renders.
 *
 * Also carries `isActive`, so the route can 404 a deactivated school without a
 * second read.
 */
export function getSchoolCrest(
  schoolId: string
): Promise<{ key: string; contentType: string } | null> {
  if (!schoolId) return Promise.resolve(null);

  return unstable_cache(
    async () => {
      const [schoolSnap, settingsSnap] = await Promise.all([
        adminDb.doc(`${RP.schools}/${schoolId}`).get(),
        adminDb.doc(`${JD.schoolSettings}/${schoolId}`).get(),
      ]);

      if (!schoolSnap.exists || schoolSnap.get("isActive") === false) return null;

      const branding = (settingsSnap.get("branding") ?? {}) as Partial<SchoolBranding>;
      if (!branding.logoKey || !branding.logoContentType) return null;

      return { key: branding.logoKey, contentType: branding.logoContentType };
    },
    ["school-crest", schoolId],
    { revalidate: 900, tags: [schoolBrandTag(schoolId)] }
  )();
}
