"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LessonStatus } from "@/types";

type Question = { number: number; question: string };
type Guide = { number: number; keyPoints: string[] };
type Content = { summary: string; questions: Question[]; markingGuide: Guide[] };

export default function ReviewLesson({
  lessonId,
  status,
  content,
}: {
  lessonId: string;
  status: LessonStatus;
  content: Content | null;
}) {
  if (!content) {
    return <GeneratePanel lessonId={lessonId} status={status} />;
  }
  return <ReviewPanel lessonId={lessonId} status={status} content={content} />;
}

/** Shown before study materials exist (draft), or if a generation was interrupted. */
function GeneratePanel({ lessonId, status }: { lessonId: string; status: LessonStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/lessons/${lessonId}/generate`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't create study materials.");
      router.refresh(); // reload the server component with the new content
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't create study materials.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      {status === "generating" && !busy && (
        <p className="mb-4 rounded-lg bg-markerSoft px-3 py-2 text-sm text-marker">
          A previous run didn&apos;t finish. Try creating the study materials again.
        </p>
      )}
      <p className="text-slate">
        We&apos;ll write a student summary, practice questions, and a marking guide from
        this lesson. You&apos;ll review and edit everything before students see it.
      </p>
      {error && (
        <p className="mt-4 rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">{error}</p>
      )}
      <button
        onClick={generate}
        disabled={busy}
        className="mt-6 w-full rounded-lg bg-brass px-4 py-3 font-medium text-ink hover:brightness-95 disabled:opacity-50"
      >
        {busy ? "Creating study materials… this can take a moment" : "Generate study materials"}
      </button>
    </div>
  );
}

/** The review gate: edit the AI output, then publish. */
function ReviewPanel({
  lessonId,
  status,
  content,
}: {
  lessonId: string;
  status: LessonStatus;
  content: Content;
}) {
  const router = useRouter();
  const [summary, setSummary] = useState(content.summary);
  const [questions, setQuestions] = useState<Question[]>(content.questions);
  // Marking guide keyPoints are edited as one line each in a textarea.
  const [guides, setGuides] = useState(
    content.markingGuide.map((g) => ({ number: g.number, text: g.keyPoints.join("\n") }))
  );
  const [busy, setBusy] = useState<false | "generate" | "publish" | "unpublish">(false);
  const [error, setError] = useState<string | null>(null);

  const published = status === "published";

  async function unpublish() {
    if (!window.confirm("Hide the study guide from students? Your content is kept and you can publish again anytime.")) {
      return;
    }
    setBusy("unpublish");
    setError(null);
    try {
      const res = await fetch(`/api/lessons/${lessonId}/publish`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't unpublish this study guide.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't unpublish this study guide.");
      setBusy(false);
    }
  }

  function setQuestion(number: number, text: string) {
    setQuestions((qs) => qs.map((q) => (q.number === number ? { ...q, question: text } : q)));
  }
  function setGuide(number: number, text: string) {
    setGuides((gs) => gs.map((g) => (g.number === number ? { ...g, text } : g)));
  }

  async function publish() {
    setBusy("publish");
    setError(null);

    // Only send fields the tutor actually changed, so tutorEdited stays accurate.
    const nextQuestions = questions;
    const nextGuide: Guide[] = guides.map((g) => ({
      number: g.number,
      keyPoints: g.text.split("\n").map((s) => s.trim()).filter(Boolean),
    }));

    const body: {
      summary?: string;
      questions?: Question[];
      markingGuide?: Guide[];
    } = {};
    if (summary !== content.summary) body.summary = summary;
    if (JSON.stringify(nextQuestions) !== JSON.stringify(content.questions))
      body.questions = nextQuestions;
    if (JSON.stringify(nextGuide) !== JSON.stringify(content.markingGuide))
      body.markingGuide = nextGuide;

    try {
      const res = await fetch(`/api/lessons/${lessonId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't publish this lesson.");
      router.push("/tutor");
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't publish this lesson.");
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!window.confirm("Create fresh study materials? This replaces the current summary, questions, and marking guide, including your edits.")) {
      return;
    }
    setBusy("generate");
    setError(null);
    try {
      const res = await fetch(`/api/lessons/${lessonId}/generate`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "We couldn't create study materials.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't create study materials.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-6">
      {published ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-markerSoft px-4 py-3">
          <p className="text-sm font-medium text-marker">
            Published — students in this class can read it. Edits below take effect when
            you publish again.
          </p>
          <button
            onClick={unpublish}
            disabled={busy !== false}
            className="shrink-0 rounded-lg border border-line bg-chalk px-3 py-1.5 text-sm font-medium text-slate disabled:opacity-50"
          >
            {busy === "unpublish" ? "Hiding…" : "Unpublish"}
          </button>
        </div>
      ) : (
        <p className="rounded-lg bg-brassSoft px-4 py-3 text-sm text-brassText">
          AI-generated — review before publishing.
        </p>
      )}

      <section>
        <label className="block">
          <span className="text-sm font-medium">Student summary</span>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={10}
            className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
          />
        </label>
      </section>

      <section>
        <h2 className="text-sm font-medium">Practice questions</h2>
        <ol className="mt-2 space-y-3">
          {questions.map((q) => (
            <li key={q.number} className="flex gap-3">
              <span className="mt-2 w-6 shrink-0 text-sm text-slate">{q.number}.</span>
              <input
                type="text"
                value={q.question}
                onChange={(e) => setQuestion(q.number, e.target.value)}
                className="w-full rounded-lg border border-line bg-chalk px-3 py-2"
              />
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="text-sm font-medium">Marking guide</h2>
        <p className="mt-0.5 text-xs text-slate">
          For you only — students never see this. One key point per line.
        </p>
        <ol className="mt-2 space-y-3">
          {guides.map((g) => (
            <li key={g.number} className="flex gap-3">
              <span className="mt-2 w-6 shrink-0 text-sm text-slate">{g.number}.</span>
              <textarea
                value={g.text}
                onChange={(e) => setGuide(g.number, e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-line bg-chalk px-3 py-2"
              />
            </li>
          ))}
        </ol>
      </section>

      {error && (
        <p className="rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">{error}</p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button
          onClick={publish}
          disabled={busy !== false}
          className="rounded-lg bg-marker px-4 py-3 font-medium text-chalk hover:bg-markerDark disabled:opacity-50 sm:flex-1"
        >
          {busy === "publish"
            ? "Publishing…"
            : published
              ? "Save and republish"
              : "Publish"}
        </button>
        <button
          onClick={regenerate}
          disabled={busy !== false}
          className="rounded-lg border border-line px-4 py-3 font-medium text-brassText disabled:opacity-50"
        >
          {busy === "generate" ? "Creating…" : "Regenerate"}
        </button>
      </div>
    </div>
  );
}
