import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "./collections";
import { assertWritable } from "./write-guard";

/**
 * A school's own identity: crest, short name, colour, motto.
 *
 * LIVES IN `jdSchoolSettings`, NOT IN `schools`. ResultPeak owns `schools` and
 * this repo never writes it (CLAUDE.md). ResultPeak also stores no crest, no
 * colour and no motto anywhere today, so there is nothing here to mirror and
 * nothing to drift from - which is what makes this different from the copies
 * the attendance rule forbids. When ResultPeak ships `schools/{id}.branding`
 * (docs/resultpeak-school-branding-prompt.md), getSchoolBrand() prefers theirs
 * and this becomes the fallback, in one function.
 *
 * NOTHING PERSONAL MAY EVER BE ADDED HERE. A crest, a name, a colour, a motto.
 * That is what lets this render on a sign-in screen before anyone is
 * authenticated, and what keeps it safe in the student device store.
 */
export interface SchoolBranding {
  /** R2 key, `branding/{schoolId}/crest{ext}`. Null until an admin uploads one. */
  logoKey: string | null;
  /** Served back verbatim, from a server-side allowlist. Never from a request. */
  logoContentType: string | null;
  /**
   * Whether the uploaded crest is a square PNG big enough to install as an app
   * icon (see lib/branding/crest, isIconCandidate).
   *
   * DECIDED AT UPLOAD, not on read. The manifest route needs the answer on every
   * request and must not open the file from R2 to get it; measuring once, when
   * the bytes are already in hand, is what keeps that route cheap.
   */
  logoIsIcon: boolean;
  /**
   * Epoch ms of the last upload, and the `?v=` in the crest URL.
   *
   * The crest is served `immutable` for a year, so freshness has to come from
   * the URL changing. Without this an admin fixing a wrong crest would watch the
   * old one persist on every device that had already seen it.
   */
  logoUpdatedAt: number | null;
  /** "Capstone" for a 360px header. Null falls back to a trimmed school name. */
  shortName: string | null;
  /** Validated by assertBrandColour() before it gets here. Null means indigo. */
  colorHex: string | null;
  /** Shown on the school front door only. Never in the header. */
  motto: string | null;
  updatedAt: number;
  updatedBy: string;
}

export const EMPTY_BRANDING: SchoolBranding = {
  logoKey: null,
  logoContentType: null,
  logoIsIcon: false,
  logoUpdatedAt: null,
  shortName: null,
  colorHex: null,
  motto: null,
  updatedAt: 0,
  updatedBy: "",
};

/**
 * Read the raw record. Almost nothing should call this - read through
 * getSchoolBrand() in lib/branding/school, which is the only display read and
 * the one place the ResultPeak handover happens. This exists for the settings
 * form, which edits the record rather than rendering it, and for the crest
 * route, which needs the storage key that never leaves the server.
 */
export async function getSchoolBranding(schoolId: string): Promise<SchoolBranding> {
  const snap = await adminDb.doc(`${JD.schoolSettings}/${schoolId}`).get();
  const raw = snap.get("branding");
  return raw ? { ...EMPTY_BRANDING, ...(raw as Partial<SchoolBranding>) } : EMPTY_BRANDING;
}

/**
 * Write branding onto the school's settings document.
 *
 * EXPLICIT NULLS, NEVER OMITTED FIELDS. `set(..., { merge: true })` deep-merges
 * a map, so leaving `logoKey` out of the patch keeps whatever was there - which
 * means "remove the crest" written the natural way would silently do nothing.
 * Callers pass the whole record; this writes the whole record.
 *
 * Merged rather than `set()` outright because the same document holds the
 * school's term, session and assessment-type settings, and replacing it would
 * destroy them.
 */
export async function saveSchoolBranding(
  schoolId: string,
  branding: Omit<SchoolBranding, "updatedAt">
): Promise<void> {
  assertWritable(JD.schoolSettings);
  await adminDb.doc(`${JD.schoolSettings}/${schoolId}`).set(
    {
      schoolId,
      branding: { ...branding, updatedAt: Date.now() },
    },
    { merge: true }
  );
}
