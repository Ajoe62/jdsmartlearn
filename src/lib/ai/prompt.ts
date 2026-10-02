import { LEVEL_LABELS, isEarlyYears } from "@/lib/class-level";
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
  /**
   * Pre-nursery and nursery, added 2026-09-13. The strictest band, not a looser
   * one: these children cannot read, so the material is written to be read
   * aloud and the questions to be answered out loud. Four questions is the
   * schema's minimum.
   */
  early_years: {
    words: "40-80 words",
    count: 4,
    guidance:
      "For children aged 2-5 who cannot read yet: a teacher or parent reads it aloud. " +
      "Sentences of 3 to 6 everyday words. Talk only about things a child can see, touch, hear or do. " +
      "No abstract ideas and no lists of facts. " +
      "Questions are asked aloud and answered by saying one word, pointing, counting or showing.",
  },
};

export function bandFor(level: ClassLevel) {
  // Before the primary test: "PN" also starts with "P".
  if (isEarlyYears(level)) return BANDS.early_years;
  if (["P1", "P2", "P3"].includes(level)) return BANDS.lower_primary;
  if (["P4", "P5", "P6"].includes(level)) return BANDS.upper_primary;
  if (level.startsWith("JSS")) return BANDS.junior;
  return BANDS.senior;
}

function curriculumFor(level: ClassLevel) {
  if (isEarlyYears(level)) return "Nigerian Early Childhood Care and Education (ECCE)";
  if (level.startsWith("P")) return "NERDC Basic Education";
  return "WAEC/NECO aligned";
}

export interface PromptInput {
  lessonText: string;
  subjectName: string;
  topicTitle: string;
  level: ClassLevel;
  /**
   * Set for a weekly note. `lessonText` is then the NUMBERED paragraphs from
   * lib/notes/arrange, and the model also says which paragraphs belong to which
   * topic. `topics` is the school's own curriculum topic titles for this subject
   * and level - curriculum, not personal data.
   */
  weekly?: { week: number | null; topics: string[] };
}

/**
 * IMPORTANT: this payload carries lesson content only.
 * Never add student names, ids, tutor names, or school names - the free tier
 * permits the provider to use submitted content. See CLAUDE.md.
 */
export function buildPrompt({ lessonText, subjectName, topicTitle, level, weekly }: PromptInput) {
  const band = bandFor(level);
  const curriculum = curriculumFor(level);

  const system = [
    `You create study materials for Nigerian school students at level ${LEVEL_LABELS[level]}.`,
    `Subject: ${subjectName}. Topic: ${topicTitle}. Curriculum: ${curriculum}.`,
    `Return ONLY JSON matching the provided schema.`,
    `Summary: ${band.words}. ${band.guidance}`,
    `Write exactly ${band.count} short-answer questions, numbered from 1.`,
    `Every question must be answerable from the lesson text alone. Never invent facts that are not in the lesson.`,
    `The marking guide gives the key points a teacher would accept for each question, not a single verbatim answer.`,
    `Use Nigerian examples and context where they fit naturally. British English spelling.`,
    ...(weekly ? weeklyInstructions(weekly.topics) : []),
  ].join("\n");

  return { system, user: `LESSON TEXT:\n\n${lessonText}` };
}

/**
 * The arranging half of a weekly note.
 *
 * The model answers with paragraph NUMBERS. It is told not to copy text, but
 * the guarantee does not rest on it obeying: the bodies are rebuilt from the
 * tutor's paragraphs whatever it returns (lib/notes/arrange).
 */
function weeklyInstructions(topics: string[]): string[] {
  const list = topics.length
    ? topics.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "(none listed)";
  return [
    ``,
    `This lesson text is one WEEK of a teacher's notes and may cover several topics. Its paragraphs are numbered [1], [2], and so on.`,
    `Also return "sections": divide the paragraphs into topics. Every paragraph number belongs to exactly one section; keep a topic's paragraphs together in one section.`,
    `For each section give: "paragraphs" (the paragraph numbers), "heading" (a short heading, at most 8 words), "topicNumber" and "topicTitle".`,
    `Match each section to one of the school's topics below and set "topicNumber" to its number and "topicTitle" to its title. Only if none fits, set "topicNumber" to 0 and "topicTitle" to a short topic name.`,
    `Do NOT copy, rewrite or summarise the teacher's text in sections. Return paragraph numbers only.`,
    `The summary and questions still cover the whole week. Do not mention the paragraph numbers in them.`,
    `School's topics for this subject and class:\n${list}`,
  ];
}

export const MAX_LESSON_CHARS = 30_000;

/**
 * Beyond this, output quality falls off on the free tier: the model starts
 * summarising the submission rather than marking it. A longer answer is
 * truncated and the tutor sees the whole thing anyway on the review screen.
 */
export const MAX_SUBMISSION_CHARS = 3_000;

export interface GradingPromptInput {
  assignmentTitle: string;
  subjectName: string;
  markingGuide: string;
  maxMarks: number;
  submissionText: string;
}

/**
 * The grading prompt.
 *
 * IMPORTANT: same rule as buildPrompt above. This payload carries the
 * assignment and the child's own words and NOTHING that identifies them. Never
 * add a student name, student id, tutor name, or school name - the free tier
 * permits the provider to use submitted content (CLAUDE.md, Assessment rules).
 *
 * The instructions push hard against two failure modes seen in marking models:
 * inventing credit for content that is not in the answer, and marking an empty
 * or off-topic answer generously out of politeness.
 */
export function buildGradingPrompt({
  assignmentTitle,
  subjectName,
  markingGuide,
  maxMarks,
  submissionText,
}: GradingPromptInput) {
  const system = [
    `You are a Nigerian secondary school teacher marking a student submission. Be fair and constructive.`,
    `Mark ONLY against the marking guide. Award nothing for content the student did not write.`,
    `If the answer is empty, off topic, or too short to judge, give a low score and say so plainly in the feedback. Do not be generous to be kind.`,
    `Set confidence to "low" when the submission is hard to read, very short, or only partly addresses the question. A tutor reads your confidence before trusting your score.`,
    `Feedback speaks TO the student, in the second person, in plain words they will understand.`,
    `topicsMastered and topicsToRevise name topics from this subject, not phrases from the answer.`,
    `Score out of ${maxMarks}. Return ONLY JSON matching the provided schema.`,
  ].join("\n");

  const user = [
    `Assignment: ${assignmentTitle}`,
    `Subject: ${subjectName}`,
    `Marking guide: ${markingGuide}`,
    `Maximum marks: ${maxMarks}`,
    ``,
    `Student submission:`,
    submissionText.slice(0, MAX_SUBMISSION_CHARS),
  ].join("\n");

  return { system, user };
}
