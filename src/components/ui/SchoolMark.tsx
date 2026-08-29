import { cn } from "@/lib/cn";
import type { SchoolBrand } from "@/lib/branding/school";

/**
 * A school's crest, or its monogram when there is no crest - which today is
 * every school (docs/SCHOOL-BRANDING.md, phase 2 adds the upload).
 *
 * No hooks and no "use client", like every other primitive here, so the same
 * component works in a server tree and inside the offline shell.
 *
 * The monogram is set in the display face and reversed out of the SCHOOL's
 * colour, with `schoolFg` as the foreground. That pair is safe by construction:
 * `schoolFg` is computed from `schoolBg` by bestForeground() and a colour that
 * cannot reach 4.5:1 either way is refused at the point an admin saves it. A
 * school that has chosen nothing gets brand indigo, which is 6.28:1 reversed.
 */
export default function SchoolMark({
  brand,
  size = "sm",
  className,
}: {
  brand: SchoolBrand;
  size?: "sm" | "lg";
  className?: string;
}) {
  const box = size === "lg" ? "h-14 w-14 text-xl" : "h-9 w-9 text-sm";

  /**
   * THE MONOGRAM IS ALWAYS RENDERED, AND THE CREST SITS ON TOP OF IT.
   *
   * A crest that fails to load must degrade to the school's name in text, never
   * to a broken image (CLAUDE.md, offline rules). That happens for real: a
   * ResultPeak-hosted https crest is cross-origin, so the service worker's
   * deny-list refuses it and it cannot paint with the network off.
   *
   * Done with layering rather than an `onError` handler on purpose. This
   * component has no "use client" and is rendered inside the offline shell as
   * well as on the server; adding a handler would make it a client component and
   * spend student JS budget on a fallback that CSS gives away. An `<img>` with
   * `alt=""` that fails to load paints nothing, so what shows through is the
   * monogram that was already there.
   */
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg",
        "bg-schoolBg text-schoolFg",
        box,
        className
      )}
      aria-hidden
    >
      <span className="font-display font-semibold tracking-[0.01em]">{brand.initials}</span>

      {brand.crestUrl && (
        /* eslint-disable-next-line @next/next/no-img-element -- our own route with
           an immutable cache header; next/image would add a proxy hop and a
           layout shift for a 40px square, and cannot proxy a data URI at all. */
        <img
          src={brand.crestUrl}
          alt=""
          className="absolute inset-0 h-full w-full bg-surface object-contain"
        />
      )}
    </span>
  );
}
