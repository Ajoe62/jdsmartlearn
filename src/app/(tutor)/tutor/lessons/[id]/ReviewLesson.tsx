"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Badge from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import { CONTROL } from "@/components/ui/Field";
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
    <div className="mt-6 space-y-4">
      {status === "generating" && !busy && (
        <Callout tone="warn" title="A previous run didn't finish">
          Try creating the study materials again.
        </Callout>
      )}

      <Card className="overflow-hidden">
        {/* The azure left rule is the accent's job: this panel is the AI moment
            on the tutor's path (docs/ilumo-brand.md section 3). */}
        <div className="border-l-4 border-l-accent bg-accentSoft px-4 py-3">
          <p className="font-display text-subheading font-semibold">
            Create the study materials
          </p>
          <p className="mt-1 text-sm text-muted">
            From this lesson, you&rsquo;ll get three things back in about a minute.
          </p>
        </div>
        <ul className="divide-y divide-line">
          <WhatYouGet
            title="A student summary"
            detail="Written for the reading level of this class."
          />
          <WhatYouGet
            title="Practice questions"
            detail="For your students to answer after reading."
          />
          <WhatYouGet
            title="A marking guide"
            detail="For you only. Students never see it."
          />
        </ul>
      </Card>

      <p className="text-sm text-muted">
        Nothing reaches your students until you review it and publish.
      </p>

      {error && <Callout tone="danger" title="We couldn't create study materials">{error}</Callout>}

      <Button onClick={generate} disabled={busy} size="lg" full>
        {busy ? "Creating study materials… this can take a moment" : "Generate study materials"}
      </Button>
    </div>
  );
}

function WhatYouGet({ title, detail }: { title: string; detail: string }) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <svg className="mt-0.5 h-5 w-5 shrink-0 text-successText" viewBox="0 0 20 20" fill="none" aria-hidden>
        <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="m6.5 10.25 2.25 2.25 4.75-5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-muted">{detail}</span>
      </span>
    </li>
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
    <div className="mt-6 space-y-5">
      {published ? (
        <Callout tone="success" title="Published">
          <span className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Students in this class can read it. Edits below take effect when you publish
              again.
            </span>
            <Button variant="secondary" onClick={unpublish} disabled={busy !== false}>
              {busy === "unpublish" ? "Hiding…" : "Unpublish"}
            </Button>
          </span>
        </Callout>
      ) : (
        /* Mandatory before publish - CLAUDE.md, AI rules. */
        <Callout tone="info" title="AI-generated — review before publishing">
          Read every section and fix anything that is wrong for your class. Nothing reaches
          your students until you publish.
        </Callout>
      )}

      <Card>
        <CardHeader
          title="Student summary"
          hint="This is what your students read first."
        />
        <div className="p-4">
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={10}
            aria-label="Student summary"
            className={CONTROL}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Practice questions"
          hint={`${questions.length} question${questions.length === 1 ? "" : "s"} for your students to answer.`}
        />
        <ol className="divide-y divide-line">
          {questions.map((q) => (
            <li key={q.number} className="flex gap-3 p-4">
              <span className="tabular mt-2.5 w-5 shrink-0 text-sm text-muted">
                {q.number}.
              </span>
              <input
                type="text"
                value={q.question}
                onChange={(e) => setQuestion(q.number, e.target.value)}
                aria-label={`Question ${q.number}`}
                className={CONTROL}
              />
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <CardHeader
          title="Marking guide"
          hint="One key point per line."
          action={<Badge tone="warn">Only you</Badge>}
        />
        <ol className="divide-y divide-line">
          {guides.map((g) => (
            <li key={g.number} className="flex gap-3 p-4">
              <span className="tabular mt-2.5 w-5 shrink-0 text-sm text-muted">
                {g.number}.
              </span>
              <textarea
                value={g.text}
                onChange={(e) => setGuide(g.number, e.target.value)}
                rows={3}
                aria-label={`Marking guide for question ${g.number}`}
                className={CONTROL}
              />
            </li>
          ))}
        </ol>
      </Card>

      {error && <Callout tone="danger" title="That didn't work">{error}</Callout>}

      {/* Sticky so Publish stays reachable at the bottom of a long review on a
          360px screen, instead of being scrolled past. */}
      <div className="sticky bottom-0 -mx-5 border-t border-line bg-surface px-5 py-3">
        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <Button onClick={publish} disabled={busy !== false} size="lg" className="sm:flex-1">
            {busy === "publish" ? "Publishing…" : published ? "Save and republish" : "Publish"}
          </Button>
          <Button variant="secondary" onClick={regenerate} disabled={busy !== false} size="lg">
            {busy === "generate" ? "Creating…" : "Regenerate"}
          </Button>
        </div>
      </div>
    </div>
  );
}
