"use client";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import Field, { CONTROL } from "@/components/ui/Field";
import type { NoteSection } from "@/types";

/**
 * Review a weekly note's topic sections before students see them.
 *
 * The AI chose which paragraphs go under which topic; every word in a section
 * is still the tutor's own (lib/notes/arrange). Here the tutor can re-file a
 * section under another topic, rename it, fix the text, reorder sections, or
 * fold one into the one above when the AI split a topic in two. There is no
 * "delete": a section is the tutor's own notes, and merging keeps every word.
 */

const OTHER = "__other";

export default function SectionsEditor({
  sections,
  onChange,
  topicOptions,
}: {
  sections: NoteSection[];
  onChange: (next: NoteSection[]) => void;
  topicOptions: { id: string; title: string }[];
}) {
  function update(i: number, patch: Partial<NoteSection>) {
    onChange(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function chooseTopic(i: number, value: string) {
    if (value === OTHER) {
      update(i, { topicId: null });
      return;
    }
    const topic = topicOptions.find((t) => t.id === value);
    if (topic) update(i, { topicId: topic.id, topicTitle: topic.title });
  }

  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  function mergeUp(i: number) {
    if (i === 0) return;
    const above = sections[i - 1];
    const merged = { ...above, body: `${above.body}\n\n${sections[i].body}` };
    onChange(sections.flatMap((s, j) => (j === i - 1 ? [merged] : j === i ? [] : [s])));
  }

  return (
    <Card>
      <CardHeader
        title="Your notes, sorted by topic"
        hint={`${sections.length} section${sections.length === 1 ? "" : "s"}. The words are yours; check each one is under the right topic.`}
      />
      <ol className="divide-y divide-line">
        {sections.map((s, i) => {
          const known = s.topicId !== null && topicOptions.some((t) => t.id === s.topicId);
          return (
            <li key={i} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-eyebrow font-semibold uppercase text-brand">
                  Section {i + 1}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>
                    Move up
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => move(i, 1)}
                    disabled={i === sections.length - 1}
                  >
                    Move down
                  </Button>
                  {i > 0 && (
                    <Button variant="ghost" onClick={() => mergeUp(i)}>
                      Join with the one above
                    </Button>
                  )}
                </span>
              </div>

              <Field label="Topic" htmlFor={`section-topic-${i}`}>
                <select
                  id={`section-topic-${i}`}
                  value={known ? s.topicId! : OTHER}
                  onChange={(e) => chooseTopic(i, e.target.value)}
                  className={CONTROL}
                >
                  {topicOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                  <option value={OTHER}>Another topic (type its name)</option>
                </select>
              </Field>

              {!known && (
                <Field label="Topic name" htmlFor={`section-topic-name-${i}`}>
                  <input
                    id={`section-topic-name-${i}`}
                    type="text"
                    value={s.topicTitle}
                    onChange={(e) => update(i, { topicTitle: e.target.value })}
                    placeholder="e.g. Figures of speech"
                    className={CONTROL}
                  />
                </Field>
              )}

              <Field label="Section heading" htmlFor={`section-heading-${i}`}>
                <input
                  id={`section-heading-${i}`}
                  type="text"
                  value={s.heading}
                  onChange={(e) => update(i, { heading: e.target.value })}
                  className={CONTROL}
                />
              </Field>

              <Field label="Notes" htmlFor={`section-body-${i}`}>
                <textarea
                  id={`section-body-${i}`}
                  value={s.body}
                  onChange={(e) => update(i, { body: e.target.value })}
                  rows={6}
                  className={`${CONTROL} text-sm leading-relaxed`}
                />
              </Field>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
