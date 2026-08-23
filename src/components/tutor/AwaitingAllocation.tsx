import EmptyState from "@/components/ui/EmptyState";

/**
 * Shown when a tutor's school enforces subject allocation and nobody has
 * allocated this tutor yet - row 4 of the truth table in
 * `lib/auth/subject-access`.
 *
 * IT EXISTS BECAUSE THE PICKER CANNOT SAY THIS. `teachableMap` returns `{}` for
 * an unallocated tutor and every form reads `{}` as "no restriction, offer
 * everything", which under enforcement is exactly backwards: the tutor would be
 * offered the school's full subject list and then refused on submit, with a
 * message about a subject they had just been shown. Pages test
 * `isAwaitingAllocation(session)` BEFORE reaching for the map and render this
 * instead of a form.
 *
 * No action button, deliberately. Allocation lives in ResultPeak and there is
 * nothing a tutor can do about it from here, so the body names who can - the
 * same shape as the "no classes assigned" state beside it.
 */
export default function AwaitingAllocation({ noun }: { noun: string }) {
  return (
    <EmptyState title={`You have no subjects yet`}>
      Your school has started assigning teachers to subjects, and nobody has
      assigned yours. Ask your school admin to add your subjects in ResultPeak —
      you can add {noun} as soon as they do.
    </EmptyState>
  );
}
