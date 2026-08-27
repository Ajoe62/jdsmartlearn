import Link from "next/link";
import SchoolMark from "./SchoolMark";
import Wordmark from "./Wordmark";
import type { SchoolBrand } from "@/lib/branding/school";

/**
 * The header both audiences share. One component so the two shells cannot drift
 * apart, which is how the family resemblance survives future edits.
 *
 * THE SCHOOL LEADS. This is a co-brand tier change from the endorsed
 * architecture in docs/ilumo-brand.md section 1 - the school's name and crest are
 * what a user reads first, JDSmartLearn sits under it at 11px, and the ilumo
 * endorsement appears only on the front door and in the footer. A school links
 * to this product from its own website, and a header that led with our name told
 * every child and teacher they had been handed off to somebody else.
 *
 * `brand` is null for a visitor we cannot place - the plain product lockup is the
 * honest answer then, because branding for a school we cannot name would be a
 * guess. Callers must pass a brand resolved from the SESSION on any signed-in
 * screen and only ever from a cookie before sign-in: the cookie is
 * attacker-supplied, and showing a teacher the wrong school's crest above their
 * own class's data is the failure this rule exists to prevent
 * (docs/SCHOOL-BRANDING.md 6c).
 *
 * Renders no person-identifying data - a school name is not one. That is what
 * keeps it safe for the service worker to cache this chrome and reuse it for
 * whoever picks the phone up next (CLAUDE.md, Offline rules).
 *
 * Solid rather than translucent: a backdrop blur is expensive to composite on
 * the mid-range Android phones this is built for.
 */
export default function AppHeader({
  home,
  brand,
  action,
}: {
  home: string;
  /** Resolved by the layout. Null renders the plain JDSmartLearn lockup. */
  brand?: SchoolBrand | null;
  /** Sign-out, normally. Absent on the sign-in pages. */
  action?: React.ReactNode;
}) {
  return (
    /* The school's colour appears as a 2px rule under the header and nowhere
       else in the chrome. A full colour band would put a school's colour behind
       the sign-out button and every status chip, and those carry meanings the
       palette is tuned for. A rule is unmistakably theirs and competes with
       nothing. `schoolQuiet` is a fill; no text ever sits on it. */
    <header
      className={
        "sticky top-0 z-30 border-b border-line bg-surface" +
        (brand ? " border-b-0 shadow-[inset_0_-2px_0_0_var(--school-bg,#3852D6)]" : "")
      }
    >
      <div className="mx-auto flex max-w-app items-center justify-between gap-3 px-5 py-2.5">
        <Link
          href={home}
          className="flex min-w-0 items-center gap-2.5 rounded-lg"
          aria-label={brand ? `${brand.name} home` : "JDSmartLearn home"}
        >
          {brand ? (
            <>
              <SchoolMark brand={brand} />
              {/* min-w-0 on both the flex child and the text: without it a long
                  school name pushes the sign-out button off a 360px screen
                  instead of truncating. */}
              <span className="min-w-0">
                <span className="block truncate font-display text-[1.0625rem] font-semibold leading-tight tracking-[-0.015em]">
                  {brand.shortName}
                </span>
                <span className="block truncate text-[0.6875rem] leading-tight text-muted">
                  JDSmartLearn
                </span>
              </span>
            </>
          ) : (
            <Wordmark size="sm" />
          )}
        </Link>
        {action}
      </div>
    </header>
  );
}
