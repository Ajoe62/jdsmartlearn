import Link from "next/link";
import Wordmark from "./Wordmark";

/**
 * The header both audiences share. One component so the two shells cannot drift
 * apart, which is how the family resemblance survives future edits.
 *
 * Renders no person-identifying data. That is what keeps it safe for the service
 * worker to cache this chrome and reuse it for whoever picks the phone up next
 * (CLAUDE.md, Offline rules).
 *
 * Solid rather than translucent: a backdrop blur is expensive to composite on
 * the mid-range Android phones this is built for.
 */
export default function AppHeader({
  home,
  action,
}: {
  home: string;
  /** Sign-out, normally. Absent on the sign-in pages. */
  action?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex max-w-app items-center justify-between gap-4 px-5 py-2.5">
        <Link href={home} className="rounded-lg" aria-label="JDSmartLearn home">
          <Wordmark size="sm" />
        </Link>
        {action}
      </div>
    </header>
  );
}
