import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Buttons and button-shaped links.
 *
 * No "use client" and no hooks anywhere in src/components/ui, on purpose: these
 * are imported by server components AND by client components like ReviewLesson.
 * A component marked "use client" could not be used in the first; one using
 * hooks could not be used in the second.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "lg";

const BASE =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg font-medium " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const VARIANT: Record<ButtonVariant, string> = {
  // The focus ring goes light on a filled button - globals.css outlines in
  // `brand`, which would be invisible against a brand fill.
  primary:
    "bg-brand text-white shadow-brand hover:bg-brandHover disabled:shadow-none " +
    "focus-visible:outline-brandRing",
  secondary: "border border-line bg-surface text-ink shadow-card hover:border-lineStrong hover:bg-canvas",
  ghost: "text-accentText hover:bg-accentSoft",
  danger: "border border-danger bg-surface text-danger hover:bg-dangerSoft",
};

const SIZE: Record<ButtonSize, string> = {
  md: "px-4 py-2.5 text-[0.9375rem]",
  lg: "px-5 py-3 text-base",
};

function classes(variant: ButtonVariant, size: ButtonSize, full?: boolean, extra?: string) {
  return cn(BASE, VARIANT[variant], SIZE[size], full && "w-full", extra);
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width on phones is the default for a form's main action. */
  full?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  full,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return <button type={type} className={classes(variant, size, full, className)} {...rest} />;
}

type ButtonLinkProps = React.ComponentPropsWithoutRef<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  full?: boolean;
};

/** For navigation. A link that performs an action should be a Button instead. */
export function ButtonLink({
  variant = "primary",
  size = "md",
  full,
  className,
  ...rest
}: ButtonLinkProps) {
  return <Link className={classes(variant, size, full, className)} {...rest} />;
}

/**
 * An external product on another domain - ResultPeak. A plain anchor rather than
 * next/link, which is for routes inside this app.
 */
export function ButtonAnchor({
  variant = "secondary",
  size = "md",
  full,
  className,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  full?: boolean;
}) {
  return (
    <a className={classes(variant, size, full, className)} rel="noopener noreferrer" {...rest} />
  );
}
