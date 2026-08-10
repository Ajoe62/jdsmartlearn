import Link from "next/link";
import { formatBytes } from "@/lib/format";
import type {
  StudentAssignment,
  StudentSubmissionView,
} from "@/types/student-dashboard";

/**
 * Work that is in but not yet marked.
 *
 * Says nothing about an AI score, even when one exists on the document. The
 * projection nulls those fields, and the wording here is chosen to match: a mark
 * does not exist for a student until their teacher releases it, and hinting at
 * one invites them to ask for a number their teacher has not agreed to.
 *
 * DELIBERATELY STATUS-AGNOSTIC. Every status except `finalised` renders this
 * same screen, `ai_grading_failed` included. A child does not need to know that
 * the AI could not read their work; their teacher does, and the tutor page tells
 * them. Do not add a branch per status - a status this file has never heard of
 * must keep landing here rather than falling through to a score.
 */
export default function SubmissionStatus({
  assignment,
  submission,
}: {
  assignment: StudentAssignment;
  submission: StudentSubmissionView;
}) {
  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/student/assignments?tab=submitted" className="text-sm text-slate">
        Back to your work
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{assignment.title}</h1>
      <p className="mt-1 text-sm text-slate">
        {assignment.subjectName} &middot; {assignment.maxMarks} marks
      </p>

      <div className="mt-6 rounded-lg border border-line bg-chalk p-4">
        <p className="font-medium">Sent to your teacher</p>
        <p className="mt-1 text-slate">
          You sent this on {new Date(submission.submittedAt).toDateString()}. Your
          teacher marks it before you see a score. Check back later.
        </p>
      </div>

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate">
          What you sent
        </h2>
        {submission.content ? (
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-chalk p-4">
            {submission.content}
          </p>
        ) : (
          <p className="mt-2 text-slate">You sent files only.</p>
        )}

        {submission.attachments.length > 0 && (
          <ul className="mt-3 space-y-2">
            {submission.attachments.map((file) => (
              <li key={file.href}>
                <a
                  href={file.href}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-chalk px-3 py-2 text-sm hover:border-marker"
                >
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="shrink-0 text-slate">{formatBytes(file.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
