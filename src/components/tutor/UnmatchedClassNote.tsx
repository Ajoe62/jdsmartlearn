import Callout from "@/components/ui/Callout";

/**
 * Said beside the subject picker when the chosen class has no subjects set for
 * this tutor in ResultPeak - see pickerAllocation() in lib/auth/subject-access.
 *
 * It exists so the picker is never silently wrong in either direction. "open"
 * (the school does not enforce subjects) explains why every subject is listed;
 * "blocked" (it does) explains an empty list and names who can fix it. Without
 * it a teacher sees a subject box that does nothing and reports it as broken.
 *
 * No action button: allocation lives in ResultPeak, so the body names who can
 * change it, the same shape as AwaitingAllocation.
 */
export default function UnmatchedClassNote({
  classLabel: className,
  state,
  noun,
}: {
  /** The class's display name, e.g. "Nursery 1". */
  classLabel: string;
  state: "open" | "blocked";
  /** What the form adds, e.g. "lessons". */
  noun: string;
}) {
  if (state === "blocked") {
    return (
      <Callout tone="warn" title={`You have no subjects in ${className} yet`}>
        Ask your school admin to add your subjects for this class in ResultPeak. You
        can add {noun} here as soon as they do.
      </Callout>
    );
  }
  return (
    <Callout tone="neutral" title={`Every subject is listed for ${className}`}>
      Your subjects for this class aren&rsquo;t set in ResultPeak yet, so you can pick
      any subject. Ask your school admin to set them.
    </Callout>
  );
}
