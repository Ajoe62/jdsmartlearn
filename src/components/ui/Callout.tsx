import { cn } from "@/lib/cn";

/**
 * A bordered note: information, a result, a warning, an error.
 *
 * Replaces the ad-hoc `rounded-lg bg-*Soft px-3 py-2 text-sm text-*` paragraph
 * that had been copied into a dozen files, each drifting slightly. The left rule
 * in full-strength colour is what makes these scannable down a long form.
 */
export type CalloutTone = "info" | "success" | "warn" | "danger" | "neutral";

const TONE: Record<CalloutTone, string> = {
  info: "border-l-accent bg-accentSoft text-ink",
  success: "border-l-successText bg-successSoft text-ink",
  warn: "border-l-warn bg-warnSoft text-ink",
  danger: "border-l-danger bg-dangerSoft text-ink",
  neutral: "border-l-lineStrong bg-canvas text-ink",
};

export default function Callout({
  tone = "info",
  title,
  className,
  children,
}: {
  tone?: CalloutTone;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn("rounded-lg border-l-4 px-4 py-3 text-sm", TONE[tone], className)}
      // Errors and warnings should reach a screen reader when they appear.
      role={tone === "danger" ? "alert" : undefined}
    >
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cn(title && "mt-1", "text-muted")}>{children}</div>}
    </div>
  );
}
