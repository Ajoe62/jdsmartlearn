import { cn } from "@/lib/cn";
import Badge from "./Badge";
import {
  NOTICE_CATEGORY_LABELS,
  type NoticeCategory,
  type NoticePriority,
} from "@/lib/announcements/notices";

/**
 * One announcement, as both a student and a tutor see it.
 *
 * No "use client" and no hooks, like everything else in components/ui: the tutor
 * dashboard renders these on the server, and the student dashboard renders them
 * inside a client component. A hook here would rule out the first.
 *
 * The dismiss control is passed in as `action` rather than built here, because
 * the two audiences post to different routes and one of them queues offline.
 */

const CATEGORY_ICON: Record<NoticeCategory, string> = {
  // Plain glyphs, not an icon font and not an SVG sprite. A student page's JS
  // budget is 30 KB gzipped (CLAUDE.md, Offline rules) and these cost nothing.
  resumption: "\u{1F4C5}",
  exam: "\u{1F4DD}",
  event: "\u{1F389}",
  urgent: "\u{26A0}\u{FE0F}",
  general: "\u{1F4E2}",
};

export default function AnnouncementCard({
  title,
  body,
  category,
  priority,
  from,
  createdAt,
  unread,
  action,
  className,
}: {
  title: string;
  body: string;
  category: NoticeCategory;
  priority: NoticePriority;
  from: string;
  createdAt: number;
  /** Drives the loud treatment. An already-read notice sits back quietly. */
  unread?: boolean;
  action?: React.ReactNode;
  className?: string;
}) {
  const urgent = priority === "urgent";

  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-4 shadow-card",
        // Urgent is a TONE. It changes nothing about when this arrived - see the
        // note on NoticePriority. The left rule is what makes it scannable in a
        // stack without shouting in colour across the whole card.
        urgent ? "border-l-4 border-l-danger border-danger/30" : "border-line",
        // Read notices stay on the page rather than vanishing: a child who
        // dismissed the resumption date this morning still needs to look it up
        // this afternoon. They just stop being loud.
        !unread && "opacity-75",
        className
      )}
      // Only the loud ones interrupt a screen reader. A quiet history of read
      // notices announcing itself on every dashboard load would be unusable.
      role={urgent && unread ? "alert" : undefined}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 text-lg leading-none">
          {CATEGORY_ICON[category]}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display font-semibold">{title}</h3>
            {urgent && <Badge tone="danger">Urgent</Badge>}
            {unread && !urgent && <Badge tone="solid">New</Badge>}
          </div>

          {/* Preserves the line breaks a head teacher typed. A term-dates notice
              is a list, and reflowing it into a paragraph makes it unreadable. */}
          <p className="mt-1.5 whitespace-pre-line text-sm text-ink">{body}</p>

          <p className="mt-2.5 text-xs text-muted">
            {NOTICE_CATEGORY_LABELS[category]} &middot; {from} &middot;{" "}
            {relativeDay(createdAt)}
          </p>

          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </article>
  );
}

/**
 * Plain words. "Today" is what a child reads; a timestamp is what a database
 * stores.
 *
 * Deliberately coarser than the lesson list's relativeTime(): an announcement
 * posted four hours ago is still "Today", and telling a student it was "4 hours
 * ago" invites them to work out whether that was before or after assembly.
 */
function relativeDay(ms: number): string {
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "Last week";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
