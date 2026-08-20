import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The surface everything sits on. `interactive` adds the hover treatment for a
 * card that is itself a link - a lesson in a list, an audience door on the
 * landing page.
 */
export function Card({
  as: As = "div",
  className,
  children,
}: {
  as?: "div" | "li" | "section" | "article";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <As className={cn("rounded-xl border border-line bg-surface shadow-card", className)}>
      {children}
    </As>
  );
}

/**
 * A whole card that navigates. The hover lifts rather than recolours, so a
 * status chip inside it keeps its meaning.
 */
export function CardLink({
  className,
  children,
  ...rest
}: React.ComponentPropsWithoutRef<typeof Link>) {
  return (
    <Link
      className={cn(
        "block rounded-xl border border-line bg-surface p-4 shadow-card transition-all",
        "hover:border-lineStrong hover:shadow-lift",
        className
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

/** Optional heading row for a Card, with a rule under it. */
export function CardHeader({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 border-b border-line px-4 py-3",
        className
      )}
    >
      <div className="min-w-0">
        <h2 className="text-subheading font-semibold">{title}</h2>
        {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
