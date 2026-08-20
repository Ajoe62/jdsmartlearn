import { SKIP_TEXT } from "@/lib/assessment/skips";
import type { SkipReason } from "@/lib/assessment/skips";

/**
 * THE skip surface. One block, however many conditions are active.
 *
 * A second banner elsewhere on the page would let a tutor fix the problem they
 * can see and believe they are finished, so everything that is currently
 * stopping marks getting through is listed here together. A fifth condition is a
 * new entry in `lib/assessment/skips.ts` and nothing here.
 *
 * No client JS: a plain server component, which is what keeps a page a tutor
 * opens on a mid-range Android phone cheap.
 */
export default function SkipNotices({ reasons }: { reasons: SkipReason[] }) {
  if (reasons.length === 0) return null;

  return (
    <section
      role="status"
      aria-label="Things to sort out"
      className="mt-6 rounded-lg border border-line bg-canvas p-4"
    >
      <h2 className="text-sm font-medium">
        {reasons.length === 1
          ? "One thing to sort out"
          : `${reasons.length} things to sort out`}
      </h2>
      <ul className={`mt-2 space-y-2 text-sm ${reasons.length > 1 ? "list-disc pl-5" : ""}`}>
        {reasons.map((reason) => (
          <li key={reason}>{SKIP_TEXT[reason]}</li>
        ))}
      </ul>
    </section>
  );
}
