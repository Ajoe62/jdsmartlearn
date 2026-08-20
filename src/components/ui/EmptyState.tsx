import { Card } from "./Card";

/**
 * An empty state invites the next action rather than reporting a count of zero
 * (CLAUDE.md, Interface writing). `action` is omitted when there is genuinely
 * nothing the person can do from here - a tutor with no classes has to go to
 * ResultPeak - and then the body says who can fix it.
 */
export default function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card className="px-5 py-8 text-center">
      <p className="text-subheading font-semibold">{title}</p>
      <div className="mx-auto mt-1.5 max-w-readable text-sm text-muted">{children}</div>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </Card>
  );
}
