import Link from "next/link";
import { cn } from "@/lib/cn";

/** Page title, optional supporting line, and one primary action. */
export default function PageHeader({
  title,
  lead,
  eyebrow,
  action,
  className,
}: {
  title: string;
  lead?: string;
  eyebrow?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-eyebrow font-semibold uppercase text-muted">{eyebrow}</p>
        )}
        <h1 className={cn("text-title", eyebrow && "mt-1")}>{title}</h1>
        {lead && <p className="mt-2 max-w-readable text-muted">{lead}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * The secondary navigation under a page header - pills rather than the row of
 * underlined links this replaced. Underlined links read as footnotes; a teacher
 * needs these to read as places to go.
 */
export function NavPills({ children }: { children: React.ReactNode }) {
  return <nav className="mt-5 flex flex-wrap gap-2">{children}</nav>;
}

export function NavPill({
  href,
  active,
  external,
  children,
}: {
  href: string;
  active?: boolean;
  /** Another product on another domain, so a plain anchor rather than next/link. */
  external?: boolean;
  children: React.ReactNode;
}) {
  const className = cn(
    // 44px like every other target: these are tapped on a phone held one-handed.
    "inline-flex min-h-[44px] items-center rounded-full px-4 py-2 text-sm font-medium transition-colors",
    active
      ? "bg-brand text-white"
      : "border border-line bg-surface text-ink hover:border-lineStrong hover:bg-canvas"
  );

  if (external) {
    return (
      <a className={className} href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    );
  }
  return (
    <Link className={className} href={href}>
      {children}
    </Link>
  );
}
