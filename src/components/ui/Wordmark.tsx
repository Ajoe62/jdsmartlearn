import { cn } from "@/lib/cn";

/**
 * The lockup: the shared ilumo mark, plus the product name as LIVE TEXT in the
 * display face.
 *
 * The wordmark is deliberately not inside the SVG. The files this replaced set
 * their wordmark with an SVG <text> element and a font-family stack, so it
 * rendered in a different font on every device - which is exactly what made the
 * old logo look improvised. Live text also stays crisp at any size, inherits
 * colour, and is selectable and readable by a screen reader.
 *
 * The endorsement is a line of text, never a second logo (docs/ilumo-brand.md
 * section 1).
 */

const SIZE = {
  sm: { mark: 28, name: "text-[1.0625rem]" },
  md: { mark: 34, name: "text-heading" },
  lg: { mark: 52, name: "text-title" },
} as const;

export default function Wordmark({
  size = "sm",
  endorsement = false,
  className,
}: {
  size?: keyof typeof SIZE;
  /** Show "an Ilumotech product" under the name. Front door and footer only. */
  endorsement?: boolean;
  className?: string;
}) {
  const { mark, name } = SIZE[size];

  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local SVG, no optimization needed */}
      <img src="/logo-mark.svg" alt="" width={mark} height={mark} aria-hidden />
      <span className="min-w-0">
        <span className={cn("block font-display font-semibold tracking-[-0.02em]", name)}>
          JDSmartLearn
        </span>
        {endorsement && (
          <span className="mt-0.5 block text-xs text-muted">an Ilumotech product</span>
        )}
      </span>
    </span>
  );
}
