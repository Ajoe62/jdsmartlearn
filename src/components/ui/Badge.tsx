import { cn } from "@/lib/cn";

/**
 * Status chips.
 *
 * The tones form a deliberate ladder - grey, blue tint, solid blue, mint - so a
 * teacher scanning a list of lessons sees which ones want attention without
 * reading a word. See docs/ilumo-brand.md section 6.
 *
 * `solid` is the loudest tone and belongs to whatever the teacher should do
 * next. Only one thing on a screen should wear it.
 */
export type BadgeTone = "neutral" | "info" | "solid" | "success" | "warn" | "danger";

const TONE: Record<BadgeTone, string> = {
  neutral: "border border-line bg-surface text-muted",
  info: "bg-accentSoft text-accentText",
  solid: "bg-accentText text-white",
  // Mint is a fill only - 1.52:1 on white - so the text on it is ink, at 11.21:1.
  success: "bg-success text-ink",
  warn: "bg-warnSoft text-warn",
  danger: "bg-dangerSoft text-danger",
};

export default function Badge({
  tone = "neutral",
  pulse,
  className,
  children,
}: {
  tone?: BadgeTone;
  /** For work in progress. Held to the reduced-motion rule in globals.css. */
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
        TONE[tone],
        pulse && "animate-pulseSoft",
        className
      )}
    >
      {children}
    </span>
  );
}
