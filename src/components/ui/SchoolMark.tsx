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

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg",
        brand.crestUrl ? "bg-surface" : "bg-schoolBg text-schoolFg",
        box,
        className
      )}
      aria-hidden
    >
      {brand.crestUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element -- the crest is served
           by our own route with an immutable cache header; next/image would add a
           proxy hop and a layout shift for a 40px square. */
        <img src={brand.crestUrl} alt="" className="h-full w-full object-contain" />
      ) : (
        <span className="font-display font-semibold tracking-[0.01em]">
          {brand.initials}
        </span>
      )}
    </span>
  );
}
