/**
 * Join class names, dropping anything falsy.
 *
 * Deliberately not `clsx` or `tailwind-merge`: this is four lines, and every
 * runtime dependency added here is bytes on a student's 3G first load.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
