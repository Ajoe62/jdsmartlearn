"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STORE, get, put } from "@/lib/offline/db";
import type { SubjectProgressCard } from "@/types/student-dashboard";

/**
 * How a student is doing, per subject.
 *
 * Cached to IndexedDB on load and rendered from there when there is no network.
 * Progress does not need to be live: it changes when a teacher releases a mark,
 * which is not something a child watches happen. One fetch on load is enough,
 * and there is no polling, no listener and no onSnapshot anywhere near it.
 *
 * The progress bar is plain HTML and CSS. A chart library on a student route
 * would cost more gzipped JS than the whole page budget allows.
 */

const CACHE_KEY = "progress";

export default function ProgressView({ initial }: { initial: SubjectProgressCard[] | null }) {
  const [cards, setCards] = useState<SubjectProgressCard[] | null>(initial);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;

    void (async () => {
      // Server data wins and is written through for the next offline visit.
      if (initial && initial.length > 0) {
        await put(STORE.meta, { cards: initial, savedAt: Date.now() }, CACHE_KEY).catch(
          () => undefined
        );
        return;
      }
      try {
        const saved = await get<{ cards: SubjectProgressCard[] }>(STORE.meta, CACHE_KEY);
        if (alive && saved?.cards.length) {
          setCards(saved.cards);
          setOffline(true);
        }
      } catch {
        // No device store. The empty state below is the honest answer.
      }
    })();

    return () => {
      alive = false;
    };
  }, [initial]);

  const list = cards ?? [];
  const totalViewed = list.reduce((n, c) => n + c.lessonsViewed, 0);
  const totalSubmitted = list.reduce((n, c) => n + c.assignmentsSubmitted, 0);
  const scored = list.filter((c) => c.averageScore !== null);
  const overall =
    scored.length === 0
      ? null
      : Math.round(
          scored.reduce((sum, c) => sum + (c.averageScore ?? 0), 0) / scored.length
        );

  return (
    <main className="mx-auto max-w-readable px-5 py-10">
      <Link href="/student" className="text-sm text-slate">
        Back to your subjects
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">Your progress</h1>

      {offline && (
        <p className="mt-2 text-xs text-slate">
          Saved on your phone. It updates when you have internet.
        </p>
      )}

      {list.length === 0 ? (
        <p className="mt-6 rounded-lg border border-line bg-chalk p-4 text-slate">
          Nothing to show yet. Read a lesson or send an assignment and your progress
          appears here.
        </p>
      ) : (
        <>
          <section className="mt-6 grid grid-cols-3 gap-3">
            <Stat label="Lessons read" value={String(totalViewed)} />
            <Stat label="Work sent" value={String(totalSubmitted)} />
            <Stat label="Average" value={overall === null ? "None yet" : `${overall}%`} />
          </section>

          <div className="mt-8 space-y-4">
            {list.map((card) => (
              <SubjectCard key={card.subjectId} card={card} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-chalk p-3 text-center">
      <p className="text-lg font-semibold">{value}</p>
      <p className="mt-0.5 text-xs text-slate">{label}</p>
    </div>
  );
}

function SubjectCard({ card }: { card: SubjectProgressCard }) {
  const percent =
    card.lessonsAvailable === 0
      ? 0
      : Math.min(100, Math.round((card.lessonsViewed / card.lessonsAvailable) * 100));

  return (
    <section className="rounded-lg border border-line bg-chalk p-4">
      <h2 className="font-medium">{card.subjectName}</h2>

      <p className="mt-3 text-sm text-slate">
        Lessons read: {card.lessonsViewed} of {card.lessonsAvailable}
      </p>
      <div
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-paper"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${card.subjectName} lessons read`}
      >
        <div className="h-full bg-marker" style={{ width: `${percent}%` }} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-slate">Your average</dt>
          <dd className="font-medium">
            {card.averageScore === null ? "No marks yet" : `${card.averageScore}%`}
          </dd>
        </div>
        <div>
          <dt className="text-slate">Counted towards your report</dt>
          <dd className="font-medium">
            {card.continuousAssessment === null
              ? "Not sent yet"
              : `${card.continuousAssessment}%`}
          </dd>
        </div>
      </dl>

      {card.topicsMastered.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">
            You know this well
          </p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {card.topicsMastered.map((topic) => (
              <li key={topic} className="text-green-800">
                {topic}
              </li>
            ))}
          </ul>
        </div>
      )}

      {card.topicsToRevise.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">
            Go over these again
          </p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {card.topicsToRevise.map((link) => (
              <li key={link.topic}>
                {/* Straight to the lesson when one matches. A topic with no
                    lesson is plain text: a wrong link wastes a child's data. */}
                {link.lessonId ? (
                  <Link
                    href={`/student/lessons/${link.lessonId}`}
                    className="text-amber-700 underline"
                  >
                    {link.topic}
                  </Link>
                ) : (
                  <Link
                    href={`/student/assignments?tab=graded`}
                    className="text-amber-700"
                  >
                    {link.topic}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
