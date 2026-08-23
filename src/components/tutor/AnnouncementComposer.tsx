"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import Field, { CONTROL } from "@/components/ui/Field";
import {
  NOTICE_CATEGORIES,
  NOTICE_CATEGORY_LABELS,
  type NoticeCategory,
  type NoticePriority,
  type NoticeReach,
} from "@/lib/announcements/notices";

/**
 * Write an announcement.
 *
 * The form offers only what this person may actually send - a tutor gets no
 * "whole school" option, and only their own classes - but that is a
 * CONVENIENCE. The route re-checks both against ResultPeak on every request; see
 * the note at the top of /api/tutor/announcements.
 *
 * NO AI ANYWHERE HERE. There is no "improve this wording" button and there must
 * not be: an announcement is a fact a school states (CLAUDE.md, Announcement
 * rules), and a model that rewrote a resumption date would be a catastrophe
 * nobody would notice until the wrong Monday.
 */

const MAX_TITLE = 100;
const MAX_BODY = 600;

export default function AnnouncementComposer({
  classes,
  isAdmin,
}: {
  classes: { id: string; name: string }[];
  isAdmin: boolean;
}) {
  const router = useRouter();

  const [audience, setAudience] = useState<"school" | "class">(
    isAdmin ? "school" : "class"
  );
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [reach, setReach] = useState<NoticeReach>("everyone");
  const [category, setCategory] = useState<NoticeCategory>("general");
  const [priority, setPriority] = useState<NoticePriority>("normal");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit() {
    setError(null);
    setSending(true);
    try {
      const res = await fetch("/api/tutor/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          audience,
          classId: audience === "class" ? classId : null,
          reach,
          category,
          priority,
          title,
          body,
          // A date input gives a local calendar day. Sent as a timestamp; the
          // route validates the range and stores exactly what arrives.
          startsAt: startsAt ? new Date(startsAt).getTime() : null,
          expiresAt: expiresAt ? endOfDay(expiresAt) : null,
        }),
      });

      if (!res.ok) {
        // The server's own message, not a rewritten one - it is the one that
        // says which field to fix.
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "We couldn't send that. Try again.");
        return;
      }

      router.push("/tutor/announcements");
      router.refresh();
    } catch {
      setError("We couldn't reach the internet. Your announcement was not sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="mt-6 space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {isAdmin && (
        <Field label="Who is this for?">
          <select
            className={CONTROL}
            value={audience}
            onChange={(e) => setAudience(e.target.value as "school" | "class")}
          >
            <option value="school">The whole school</option>
            <option value="class">One class</option>
          </select>
        </Field>
      )}

      {audience === "class" && (
        <Field
          label="Class"
          hint={classes.length === 0 ? undefined : "Only classes you teach."}
          htmlFor="ann-class"
        >
          <select
            id="ann-class"
            className={CONTROL}
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="Who should see it?"
        hint="Students never see a staff-only announcement."
        htmlFor="ann-reach"
      >
        <select
          id="ann-reach"
          className={CONTROL}
          value={reach}
          onChange={(e) => setReach(e.target.value as NoticeReach)}
        >
          <option value="everyone">Students and teachers</option>
          <option value="students">Students only</option>
          <option value="tutors">Teachers only</option>
        </select>
      </Field>

      <Field label="What kind of announcement?" htmlFor="ann-category">
        <select
          id="ann-category"
          className={CONTROL}
          value={category}
          onChange={(e) => setCategory(e.target.value as NoticeCategory)}
        >
          {NOTICE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {NOTICE_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Title" htmlFor="ann-title">
        <input
          id="ann-title"
          className={CONTROL}
          value={title}
          maxLength={MAX_TITLE}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="School resumes on Monday 8 September"
        />
      </Field>

      <Field
        label="Announcement"
        hint={`${body.length} of ${MAX_BODY} characters. Anything longer belongs in a lesson or a scheme of work.`}
        htmlFor="ann-body"
      >
        <textarea
          id="ann-body"
          className={CONTROL}
          rows={5}
          value={body}
          maxLength={MAX_BODY}
          onChange={(e) => setBody(e.target.value)}
          placeholder={"Second term begins on Monday 8 September.\nSchool opens at 7:30am."}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Start showing"
          hint="Leave blank to show it now."
          htmlFor="ann-starts"
        >
          <input
            id="ann-starts"
            type="date"
            className={CONTROL}
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </Field>

        <Field
          label="Stop showing"
          hint="Leave blank to keep it until you take it down."
          htmlFor="ann-expires"
        >
          <input
            id="ann-expires"
            type="date"
            className={CONTROL}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </Field>
      </div>

      <Field
        label="How urgent is it?"
        hint="Urgent shows in red at the top. It does not arrive any sooner."
        htmlFor="ann-priority"
      >
        <select
          id="ann-priority"
          className={CONTROL}
          value={priority}
          onChange={(e) => setPriority(e.target.value as NoticePriority)}
        >
          <option value="normal">Normal</option>
          <option value="urgent">Urgent</option>
        </select>
      </Field>

      {error && <Callout tone="danger">{error}</Callout>}

      <Button type="submit" full disabled={sending} size="lg">
        {sending ? "Sending…" : "Send announcement"}
      </Button>
    </form>
  );
}

/**
 * A date input gives a calendar day; "stop showing on the 12th" means the end of
 * the 12th, not its first second. Without this a notice set to expire today
 * would already be gone when the teacher pressed send.
 */
function endOfDay(value: string): number {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
