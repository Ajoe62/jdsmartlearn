"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader, { NavPill, NavPills } from "@/components/ui/PageHeader";
import { STORE, get } from "@/lib/offline/db";
import type { StoredScheme } from "@/lib/offline/db";
import type { StudentScheme } from "@/types/schemes";

/**
 * A scheme of work, as a student reads it.
 *
 * Rendered by both paths. The difference from a lesson: the device holds only
 * the SUMMARY of a scheme, not its body, because a dozen full curriculum
 * documents would not fit in one sync response on a 3G link. So offline this can
 * show the title, the term and the week list only when the body was fetched
 * earlier; otherwise it says plainly that the outline needs a connection.
 *
 * A scheme has no marking guide and no field one could occupy. It is the
 * safest thing in the product to put on a phone.
 */
export default function SchemeReaderView({
  schemeId,
  initial,
}: {
  schemeId: string;
  initial: StudentScheme | null;
}) {
  /**
   * The body, and it only ever comes from the server. There is no setter:
   * the device holds SUMMARIES only, so a scheme opened offline for the first
   * time cannot gain a body from anywhere, and pretending otherwise would mean
   * a state variable that is always its initial value.
   */
  const scheme = initial;
  const [summary, setSummary] = useState<StoredScheme | null>(null);

  useEffect(() => {
    if (initial) return;
    let alive = true;
    void (async () => {
      try {
        const row = await get<StoredScheme>(STORE.schemes, schemeId);
        if (alive && row) setSummary(row);
      } catch {
        // No device store. The empty state below covers it.
      }
    })();
    return () => {
      alive = false;
    };
  }, [schemeId, initial]);

  const title = scheme?.title ?? summary?.title;
  const term = scheme ?? summary;

  if (!title) {
    return (
      <main className="mx-auto max-w-readable px-5 py-8">
        <EmptyState title="We couldn't open that scheme of work">
          It may have been taken down, or you may need to connect once to load it.
        </EmptyState>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-readable px-5 py-8">
      <PageHeader
        eyebrow="Scheme of work"
        title={title}
        lead={term ? termLabel(term) : undefined}
      />

      <NavPills>
        <NavPill href="/student">All subjects</NavPill>
        {(scheme?.subjectId ?? summary?.subjectId) && (
          <NavPill
            href={`/student/subjects/${encodeURIComponent(
              (scheme?.subjectId ?? summary?.subjectId)!
            )}`}
          >
            Back to {scheme?.subjectName ?? summary?.subjectName}
          </NavPill>
        )}
      </NavPills>

      {!scheme ? (
        <div className="mt-6">
          <EmptyState title="Connect once to read this">
            The outline is not saved on your phone yet. Open it when you have
            internet and it will be here next time.
          </EmptyState>
        </div>
      ) : (
        <>
          {scheme.weeks.length > 0 && (
            <Card className="mt-6">
              <CardHeader title="Week by week" />
              <ol className="divide-y divide-line">
                {scheme.weeks.map((w) => (
                  <li key={w.week} className="flex gap-3 px-4 py-3">
                    <span className="w-16 shrink-0 text-sm font-medium text-muted">
                      Week {w.week}
                    </span>
                    <span className="text-sm">{w.topic}</span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {scheme.text && (
            <div className="mt-6">
              {/* Preserves the document's own line breaks. A scheme is a list of
                  topics; reflowing it into prose makes it unreadable. */}
              <p className="whitespace-pre-line text-[0.9375rem] leading-relaxed">
                {scheme.text}
              </p>
            </div>
          )}

          {scheme.file && (
            <p className="mt-6 text-sm">
              <a
                className="underline"
                href={`/api/schemes/${encodeURIComponent(scheme.schemeId)}/file`}
              >
                Open the original document
              </a>{" "}
              <span className="text-muted">({formatSize(scheme.file.size)})</span>
            </p>
          )}
        </>
      )}
    </main>
  );
}

function termLabel(row: { term: string | null; session: string | null }): string {
  if (row.term === null || row.session === null) return "Earlier";
  return `${row.term}, ${row.session}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
