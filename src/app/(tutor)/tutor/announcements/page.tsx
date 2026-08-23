import { redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
import AnnouncementCard from "@/components/ui/AnnouncementCard";
import WithdrawButton from "@/components/tutor/WithdrawButton";
import { getTutorSession } from "@/lib/auth/tutor";
import { listNoticesByAuthor } from "@/lib/db/announcements";
import { getClassesByIds, listClassesForSchool } from "@/lib/db/resultpeak";
import { isLive, toNoticeItem } from "@/lib/announcements/notices";

/**
 * Announcements this person has sent.
 *
 * Scoped to the author, not the school. "Every notice anybody ever sent" is not
 * a screen anyone asked for, and it would put one tutor's class notices in front
 * of every other tutor.
 *
 * A school admin still sees only their own here; withdrawing someone else's is
 * possible through the API by design (see deleteNotice) but is not a browsing
 * surface, because a list of other people's messages is a moderation feature and
 * nobody has asked for one.
 */
export default async function AnnouncementsPage() {
  const session = await getTutorSession();
  if (!session) redirect("/tutor/sign-in");

  const [mine, classes] = await Promise.all([
    listNoticesByAuthor(session.schoolId, session.uid),
    session.isAdmin
      ? listClassesForSchool(session.schoolId)
      : getClassesByIds(session.assignedClasses),
  ]);

  const classNames = new Map(classes.map((c) => [c.id, c.name]));
  const now = Date.now();

  return (
    <main className="mx-auto max-w-app px-5 py-8">
      <PageHeader
        title="Announcements"
        lead="Resumption dates, exam timetables, changes to activities. Students and teachers see these on their dashboards."
        action={<ButtonLink href="/tutor/announcements/new">New announcement</ButtonLink>}
      />

      <NavPills>
        <NavPill href="/tutor">Lessons</NavPill>
        <NavPill href="/tutor/assignments">Assignments</NavPill>
        <NavPill href="/tutor/schemes">Schemes of work</NavPill>
        <NavPill href="/tutor/announcements" active>
          Announcements
        </NavPill>
        <NavPill href="/tutor/sign-ins">Student sign-ins</NavPill>
      </NavPills>

      <div className="mt-8">
        {mine.length === 0 ? (
          <EmptyState
            title="No announcements yet"
            action={
              <ButtonLink href="/tutor/announcements/new">New announcement</ButtonLink>
            }
          >
            Send one when there is something the whole class or the whole school
            needs to know.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {mine.map((n) => {
              const live = isLive(n, now);
              const scheduled = n.startsAt > now;
              return (
                <li key={n.id}>
                  <AnnouncementCard
                    {...toNoticeItem(n)}
                    unread={live}
                    action={
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">
                          {n.audience === "school"
                            ? "Whole school"
                            : (classNames.get(n.targetId) ?? "One class")}
                        </Badge>
                        <Badge tone="neutral">{reachLabel(n.reach)}</Badge>
                        {scheduled && (
                          <Badge tone="info">Starts {formatDay(n.startsAt)}</Badge>
                        )}
                        {!live && !scheduled && <Badge tone="neutral">Finished</Badge>}
                        <WithdrawButton id={n.id} />
                      </div>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}

function reachLabel(reach: string): string {
  if (reach === "students") return "Students only";
  if (reach === "tutors") return "Teachers only";
  return "Students and teachers";
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
