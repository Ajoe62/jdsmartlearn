import Badge, { type BadgeTone } from "@/components/ui/Badge";
import type { LessonStatus } from "@/types";

/**
 * The status ladder: grey, blue tint, solid blue, mint (docs/ilumo-brand.md
 * section 6). "Ready to review" is the loudest because it is the only state
 * waiting on the teacher.
 */
const CHIP: Record<LessonStatus, { label: string; tone: BadgeTone; pulse?: boolean }> = {
  draft: { label: "Draft", tone: "neutral" },
  generating: { label: "Generating…", tone: "info", pulse: true },
  generated: { label: "Ready to review", tone: "solid" },
  published: { label: "Published", tone: "success" },
};

export default function LessonStatusBadge({ status }: { status: LessonStatus }) {
  const chip = CHIP[status] ?? CHIP.draft;
  return (
    <Badge tone={chip.tone} pulse={chip.pulse}>
      {chip.label}
    </Badge>
  );
}
