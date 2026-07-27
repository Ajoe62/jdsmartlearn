import type { ClassLevel } from "@/types";

/**
 * Reading-level bands. Age-appropriate simplification is the most likely
 * failure mode on a lightweight model - score primary output separately
 * during the pilot. Do not loosen these instructions.
 */
const BANDS: Record<string, { words: string; count: number; guidance: string }> = {
  lower_primary: {
    words: "80-150 words",
    count: 5,
    guidance:
      "Very short sentences. Only words a 6-9 year old uses. One idea per sentence. No sub-clauses.",
  },
  upper_primary: {
    words: "100-200 words",
    count: 6,
    guidance:
      "Simple sentences for ages 9-12. Explain any new term in the same sentence you use it.",
  },
  junior: {
    words: "150-250 words",
    count: 8,
    guidance: "Clear sentences for ages 12-15. Subject vocabulary is fine when explained.",
  },
  senior: {
    words: "150-300 words",
    count: 8,
    guidance:
      "Ages 15-18. Some questions should require explanation, not just recall. WAEC-style phrasing.",
  },
};

function bandFor(level: ClassLevel) {
  if (["P1", "P2", "P3"].includes(level)) return BANDS.lower_primary;
  if (["P4", "P5", "P6"].includes(level)) return BANDS.upper_primary;
  if (level.startsWith("JSS")) return BANDS.junior;
  return BANDS.senior;
}

export interface PromptInput {
  lessonText: string;
  subjectName: string;
  topicTitle: string;
  level: ClassLevel;
}

/**
 * IMPORTANT: this payload carries lesson content only.
 * Never add student names, ids, tutor names, or school names - the free tier
 * permits the provider to use submitted content. See CLAUDE.md.
 */
export function buildPrompt({ lessonText, subjectName, topicTitle, level }: PromptInput) {
  const band = bandFor(level);
  const curriculum = level.startsWith("P") ? "NERDC Basic Education" : "WAEC/NECO aligned";

  const system = [
    `You create study materials for Nigerian school students at level ${level}.`,
    `Subject: ${subjectName}. Topic: ${topicTitle}. Curriculum: ${curriculum}.`,
    `Return ONLY JSON matching the provided schema.`,
    `Summary: ${band.words}. ${band.guidance}`,
    `Write exactly ${band.count} short-answer questions, numbered from 1.`,
    `Every question must be answerable from the lesson text alone. Never invent facts that are not in the lesson.`,
    `The marking guide gives the key points a teacher would accept for each question, not a single verbatim answer.`,
    `Use Nigerian examples and context where they fit naturally. British English spelling.`,
  ].join("\n");

  return { system, user: `LESSON TEXT:\n\n${lessonText}` };
}

export const MAX_LESSON_CHARS = 30_000;
