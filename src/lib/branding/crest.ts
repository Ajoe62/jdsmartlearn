/**
 * What counts as a crest file. Pure, no imports - shared by the upload route,
 * the serving route and the tests.
 *
 * SEPARATE FROM `STORABLE_TYPES` in lib/storage/provider on purpose. That list
 * is lesson material: PDFs, Word documents, photographs of exercise books. A
 * crest is an image and only an image, and the two lists must not be able to
 * widen each other - a `.docx` crest is nonsense, and a PDF crest served inline
 * from an unauthenticated route is a liability.
 */

/** Response content types the serving route may emit. Order is not significant. */
export const CREST_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;

export type CrestType = (typeof CREST_TYPES)[number];

/** Accepted uploads, by extension. `.jpeg` and `.jpg` are the same type. */
export const CREST_EXTENSIONS: Record<string, CrestType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/**
 * 150 KB.
 *
 * Small on purpose. This loads on the sign-in screen of a child on a throttled
 * 3G link, before anything else they came for. A crest is a flat logo; anything
 * over this is a photograph or an unoptimised export, and telling the admin so
 * is more useful than silently making every sign-in slower.
 */
export const MAX_CREST_BYTES = 150 * 1024;

/**
 * The smallest PNG that can also serve as an installed app icon.
 *
 * Android wants 192 and 512 for a home-screen install, and this repo takes no
 * image-processing dependency (and should not start). So the school supplies one
 * square PNG at least this big and it is used directly - see the manifest route,
 * which falls back to the product tile when no PNG is available.
 */
export const MIN_ICON_PX = 512;

/** Why an upload was refused, in words an admin can act on. */
export type CrestRefusal = string;

export function crestTypeFor(filename: string): CrestType | null {
  const dot = filename.lastIndexOf(".");
  // `dot < 1`, not `dot < 0`: a name that is nothing but an extension (".png")
  // is a dotfile, not an upload. The bytes are validated separately, so this is
  // about refusing input that makes no sense rather than about safety.
  if (dot < 1) return null;
  return CREST_EXTENSIONS[filename.slice(dot).toLowerCase()] ?? null;
}

/**
 * PNG intrinsic size, read from the IHDR chunk.
 *
 * Eight bytes of signature, then a length and the chunk type, then width and
 * height as big-endian 32-bit integers - so the numbers are always at offsets 16
 * and 20. Sixteen lines, and it saves a dependency whose only job here would be
 * to read those two integers.
 *
 * Returns null for anything that is not a PNG, including a file merely NAMED
 * .png. A renamed JPEG reaching the manifest as an icon would install a broken
 * tile on a child's home screen.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return null;
  }
  const read32 = (at: number) =>
    ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  return { width: read32(16), height: read32(20) };
}

/**
 * Whether a stored crest is usable as an installed app icon.
 *
 * PNG only, and square enough that a maskable tile does not crop the school's
 * name off. An SVG crest is fine on screen and useless here: Android's install
 * prompt wants raster.
 */
export function isIconCandidate(
  contentType: string,
  size: { width: number; height: number } | null
): boolean {
  if (contentType !== "image/png" || !size) return false;
  if (size.width < MIN_ICON_PX || size.height < MIN_ICON_PX) return false;
  // Within 2% of square. A logo that is twice as wide as it is tall becomes a
  // letterboxed smudge at 192px.
  return Math.abs(size.width - size.height) / Math.max(size.width, size.height) <= 0.02;
}
