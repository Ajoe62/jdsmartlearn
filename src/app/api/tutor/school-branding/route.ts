import { NextResponse } from "next/server";
import { getTutorSession } from "@/lib/auth/tutor";
import {
  getSchoolBranding,
  saveSchoolBranding,
  type SchoolBranding,
} from "@/lib/db/school-branding";
import { revalidateSchoolBrand } from "@/lib/branding/school";
import { assertBrandColour } from "@/lib/branding/colour";
import {
  MAX_CREST_BYTES,
  MIN_ICON_PX,
  crestTypeFor,
  isIconCandidate,
  pngSize,
} from "@/lib/branding/crest";
import { writeAuditLog } from "@/lib/db/lessons";
import { deleteFile, putFile, storageConfigured } from "@/lib/storage/provider";

export const maxDuration = 30;

/**
 * Save a school's branding. SCHOOL ADMIN ONLY.
 *
 * Not a tutor-level control, for the same reason assessment settings are not:
 * this decides what every child, parent and member of staff at the school sees
 * above their own work, and one teacher should not be able to restyle the
 * school. Checked server-side here, and the settings page also refuses to render
 * the form - but the check that matters is this one.
 *
 * `multipart/form-data` because the crest rides along. Fields are all optional;
 * anything omitted keeps its current value, and `removeLogo=1` clears the crest.
 *
 * The school is NEVER taken from the request. It comes from the session, whose
 * `schoolId` is a Firebase custom claim - so an admin cannot rebrand a school
 * they do not administer by changing a form field.
 */

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Trimmed, length-capped, and empty means "clear it". */
function text(form: FormData, field: string, max: number): string | null | undefined {
  const raw = form.get(field);
  if (raw === null) return undefined; // absent: keep what is stored
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().slice(0, max);
  return value === "" ? null : value;
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);
  if (!session.isAdmin) {
    return bad("Only a school admin can change your school's branding.", 403);
  }

  const form = await req.formData().catch(() => null);
  if (!form) return bad("That form didn't arrive. Try again.");

  const current = await getSchoolBranding(session.schoolId);
  const next: Omit<SchoolBranding, "updatedAt"> = {
    ...current,
    updatedBy: session.uid,
  };

  // ----- colour -----
  const colorHex = text(form, "colorHex", 9);
  if (colorHex !== undefined) {
    const checked = assertBrandColour(colorHex);
    // The refusal names the measured ratio. Do not silently darken their colour:
    // a school whose colour came out unusable deserves to be told, and a darker
    // shade of the same colour usually clears it.
    if (!checked.ok) return bad(checked.error);
    next.colorHex = colorHex === null ? null : checked.colour.bg;
  }

  // ----- words -----
  const shortName = text(form, "shortName", 40);
  if (shortName !== undefined) next.shortName = shortName;

  const motto = text(form, "motto", 120);
  if (motto !== undefined) next.motto = motto;

  // ----- crest -----
  const removeLogo = form.get("removeLogo") === "1";
  const file = form.get("logo");
  const hasUpload = file instanceof File && file.size > 0;

  if (hasUpload && removeLogo) {
    return bad("Choose either a new crest or removing the current one, not both.");
  }

  let replacedKey: string | null = null;

  if (removeLogo && current.logoKey) {
    replacedKey = current.logoKey;
    next.logoKey = null;
    next.logoContentType = null;
    next.logoIsIcon = false;
    next.logoUpdatedAt = null;
  }

  if (hasUpload) {
    if (!storageConfigured()) {
      // R2 absent degrades to text-only everywhere else in the product; say so
      // rather than failing silently, because the admin is watching this form.
      return bad(
        "File storage isn't set up yet, so a crest can't be saved. Your school's name and monogram still show.",
        503
      );
    }
    if (file.size > MAX_CREST_BYTES) {
      return bad(
        `That file is ${Math.round(file.size / 1024)} KB. A crest must be under ${Math.round(
          MAX_CREST_BYTES / 1024
        )} KB - it loads on every sign-in, including on a slow connection.`
      );
    }

    const contentType = crestTypeFor(file.name);
    if (!contentType) return bad("Use a PNG, JPG or SVG file.");

    const bytes = new Uint8Array(await file.arrayBuffer());

    // Measured once, here, while the bytes are in hand - the manifest route
    // needs the answer on every request and must not fetch from R2 to get it.
    const size = pngSize(bytes);
    if (contentType === "image/png" && !size) {
      return bad("That file is named .png but isn't a PNG. Re-export it and try again.");
    }
    const logoIsIcon = isIconCandidate(contentType, size);

    /**
     * Extension in the key, so replacing a PNG with an SVG does not leave the
     * old object serving under a name that now claims the wrong type. The
     * previous object is deleted below when the key actually changed.
     */
    const ext = contentType === "image/svg+xml" ? "svg" : contentType === "image/png" ? "png" : "jpg";
    const key = `branding/${session.schoolId}/crest.${ext}`;

    try {
      await putFile(key, Buffer.from(bytes), contentType);
    } catch (err) {
      console.error(`school ${session.schoolId}: storing crest failed`, err);
      return bad("Storing the crest failed. Check your connection and try again.", 502);
    }

    if (current.logoKey && current.logoKey !== key) replacedKey = current.logoKey;

    next.logoKey = key;
    next.logoContentType = contentType;
    next.logoIsIcon = logoIsIcon;
    next.logoUpdatedAt = Date.now();
  }

  await saveSchoolBranding(session.schoolId, next);

  // Same-key replacements overwrite in place; a changed extension or a removal
  // leaves the old object behind. Best effort - a stray object is not worth
  // failing a save the admin has already seen succeed.
  if (replacedKey && replacedKey !== next.logoKey) {
    try {
      await deleteFile(replacedKey);
    } catch (err) {
      console.error(`school ${session.schoolId}: removing replaced crest failed`, err);
    }
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "school.branding.save",
    entityId: session.schoolId,
    detail: [
      hasUpload ? "crest=uploaded" : removeLogo ? "crest=removed" : "crest=unchanged",
      `icon=${next.logoIsIcon}`,
      `colour=${next.colorHex ?? "default"}`,
    ].join(" "),
  });

  // Without this the crest cache above would hold the old value for up to 15
  // minutes, and an admin who has just uploaded would upload again.
  revalidateSchoolBrand(session.schoolId);

  return NextResponse.json({
    ok: true,
    logoIsIcon: next.logoIsIcon,
    // Surfaced so the form can say why an otherwise fine crest will not become
    // the home-screen icon, rather than leaving the admin to wonder.
    iconNote:
      hasUpload && !next.logoIsIcon
        ? `Saved. It shows everywhere in the app, but a home-screen icon needs a square PNG at least ${MIN_ICON_PX}px, so the JDSmartLearn icon stays for now.`
        : null,
  });
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
