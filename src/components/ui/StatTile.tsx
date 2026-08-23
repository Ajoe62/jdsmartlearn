import { cn } from "@/lib/cn";

/**
 * One number with a label under it. A row of three sits above the subject shelf.
 *
 * No "use client" and no hooks, like everything else in components/ui.
 *
 * DELIBERATELY NOT A CHART, and not a progress ring. The screen is 360px wide on
 * a throttled 3G link; three numbers a child can read at a glance beat anything
 * that needs a legend, and they cost no JavaScript at all.
 */

export type StatTone = "neutral" | "attention" | "good";

const TONE: Record<StatTone, { value: string; ring: string }> = {
  neutral: { value: "text-ink", ring: "border-line" },
  // Danger for the count that means "you are late". The tile is small enough
  // that a coloured number reads as urgency without the card shouting.
  attention: { value: "text-danger", ring: "border-danger/30" },
  good: { value: "text-successText", ring: "border-line" },
};

export default function StatTile({
  value,
  label,
  tone = "neutral",
  href,
  className,
}: {
  value: number | string;
  label: string;
  tone?: StatTone;
  /** Renders as a link when the number leads somewhere. */
  href?: string;
  className?: string;
}) {
  const styles = TONE[tone];
  const inner = (
    <>
      <p className={cn("font-display text-2xl font-semibold tabular-nums", styles.value)}>
        {value}
      </p>
      <p className="mt-0.5 text-xs leading-tight text-muted">{label}</p>
    </>
  );

  const shell = cn(
    "flex min-h-[76px] flex-col justify-center rounded-xl border bg-surface px-3 py-2.5 text-center",
    styles.ring,
    className
  );

  if (href) {
    return (
      <a className={cn(shell, "transition-colors hover:bg-canvas")} href={href}>
        {inner}
      </a>
    );
  }
  return <div className={shell}>{inner}</div>;
}

/** The row. Three across even at 360px - the tiles are sized for it. */
export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-2.5">{children}</div>;
}
