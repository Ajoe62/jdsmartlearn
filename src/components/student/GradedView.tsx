import Link from "next/link";
import type {
  StudentAssignment,
  StudentSubmissionView,
} from "@/types/student-dashboard";

/**
 * A released mark.
 *
 * Only ever rendered for a submission with status "finalised", which is the only
 * status where the projection fills in a score, feedback or topics. Everything
 * shown here has been through a teacher.
 *
 * No marking guide reaches this component. `StudentSubmissionView` has no field
 * for one, and the page builds it with toStudentSubmissionPayload().
 */
export default function GradedView({
  assignment,
  submission,
}: {
  assignment: StudentAssignment;
  submission: StudentSubmissionView;
}) {
  const score = submission.finalScore;
  const percentage =
    score === null || submission.maxMarks === 0
      ? null
      : Math.round((score / submission.maxMarks) * 100);

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/student/assignments?tab=graded" className="text-sm text-muted">
        Back to your work
      </Link>
      <h1 className="mt-3 text-title">{assignment.title}</h1>
      <p className="mt-1 text-sm text-muted">{assignment.subjectName}</p>

      <div className="mt-6 rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-4xl font-semibold">
          {score} / {submission.maxMarks}
        </p>
        {percentage !== null && <p className="mt-1 text-muted">{percentage}%</p>}
      </div>

      {submission.teacherComment && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            From your teacher
          </h2>
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-surface p-4">
            {submission.teacherComment}
          </p>
        </section>
      )}

      {submission.feedback && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Feedback
          </h2>
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-surface p-4">
            {submission.feedback}
          </p>
        </section>
      )}

      {submission.strengths && submission.strengths.length > 0 && (
        <List title="What you did well" items={submission.strengths} />
      )}

      {submission.improvements && submission.improvements.length > 0 && (
        <List title="What to work on" items={submission.improvements} />
      )}

      {submission.topicsMastered && submission.topicsMastered.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            You know this well
          </h2>
          <ul className="mt-2 space-y-1">
            {submission.topicsMastered.map((topic) => (
              <li key={topic} className="text-successText">
                {topic}
              </li>
            ))}
          </ul>
        </section>
      )}

      {submission.topicsToRevise && submission.topicsToRevise.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Go over these again
          </h2>
          <ul className="mt-2 space-y-1">
            {submission.topicsToRevise.map((link) => (
              <li key={link.topic}>
                {/* A topic with no matching lesson renders as plain text. Sending a
                    child to the wrong lesson is worse than sending them nowhere. */}
                {link.lessonId ? (
                  <Link
                    href={`/student/lessons/${link.lessonId}`}
                    className="text-warn underline"
                  >
                    {link.topic}
                  </Link>
                ) : (
                  <span className="text-warn">{link.topic}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          What you sent
        </h2>
        {submission.content ? (
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-surface p-4 text-muted">
            {submission.content}
          </p>
        ) : (
          <p className="mt-2 text-muted">You sent files only.</p>
        )}
      </section>
    </main>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
