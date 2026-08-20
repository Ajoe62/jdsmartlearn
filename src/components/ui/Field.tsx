import { cn } from "@/lib/cn";

/**
 * Form field chrome: label, optional hint, optional error, and the control.
 *
 * The control styles are exported separately because some callers need to put
 * them on a `<select>` or a third-party input directly.
 */

/**
 * `lineInput` rather than `line`: WCAG 1.4.11 wants 3:1 on the boundary that
 * identifies a control, and a hairline grey does not reach it. See the token's
 * note in tailwind.config.ts.
 */
export const CONTROL =
  "w-full rounded-lg border border-lineInput bg-surface px-3 py-2.5 text-ink " +
  "transition-colors hover:border-muted focus:border-brand " +
  "disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-muted";

export const CONTROL_INVALID = "border-danger hover:border-danger";

export default function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("block", className)}>
      <label className="block text-sm font-medium" htmlFor={htmlFor}>
        {label}
      </label>
      {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      <div className="mt-1.5">{children}</div>
      {error && (
        <p className="mt-1.5 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
