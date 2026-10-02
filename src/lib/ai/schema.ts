import { z } from "zod";

/** Validated shape of every AI generation. Never trust raw model output. */
export const generationSchema = z.object({
  summary: z.string().min(50).max(4000),
  questions: z
    .array(z.object({ number: z.number().int().positive(), question: z.string().min(5) }))
    .min(4)
    .max(12),
  markingGuide: z
    .array(
      z.object({
        number: z.number().int().positive(),
        keyPoints: z.array(z.string().min(2)).min(1).max(6),
      })
    )
    .min(4)
    .max(12),
});

/**
 * A weekly note: the study guide PLUS how the week's paragraphs divide into
 * topics. Paragraph NUMBERS only, never text - see lib/notes/arrange for why
 * that is what keeps the tutor's words their own.
 */
export const weeklyGenerationSchema = generationSchema.extend({
  sections: z
    .array(
      z.object({
        heading: z.string().max(200),
        topicNumber: z.number().int().min(0),
        topicTitle: z.string().max(200),
        paragraphs: z.array(z.number().int()).max(400),
      })
    )
    .min(1)
    .max(12),
});

export type GenerationResult = z.infer<typeof generationSchema> & {
  sections?: z.infer<typeof weeklyGenerationSchema>["sections"];
};

/**
 * Validated shape of one grading call.
 *
 * A FACTORY, because the upper bound on `score` is the assignment's own
 * maxMarks. The route clamps again after parsing: a schema bound rejects the
 * whole response, and a rejected response costs a retry, whereas a clamp keeps a
 * usable mark. Two checks, because a model returning 40 out of 25 would
 * otherwise inflate a real child's continuous assessment.
 */
export function gradingSchema(maxMarks: number) {
  return z.object({
    score: z.number().min(0).max(maxMarks),
    confidence: z.enum(["high", "medium", "low"]),
    feedback: z.string().max(500),
    strengths: z.array(z.string()).max(4),
    improvements: z.array(z.string()).max(4),
    topicsMastered: z.array(z.string()).max(5),
    topicsToRevise: z.array(z.string()).max(5),
  });
}

export type GradingResult = z.infer<ReturnType<typeof gradingSchema>>;

/** JSON Schema for the grading call's native structured output. */
export const gradingResponseSchema = {
  type: "object",
  properties: {
    score: { type: "number" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    feedback: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
    topicsMastered: { type: "array", items: { type: "string" } },
    topicsToRevise: { type: "array", items: { type: "string" } },
  },
  required: [
    "score",
    "confidence",
    "feedback",
    "strengths",
    "improvements",
    "topicsMastered",
    "topicsToRevise",
  ],
} as const;

/** JSON Schema handed to the model for native structured output. */
export const generationResponseSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { number: { type: "integer" }, question: { type: "string" } },
        required: ["number", "question"],
      },
    },
    markingGuide: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          keyPoints: { type: "array", items: { type: "string" } },
        },
        required: ["number", "keyPoints"],
      },
    },
  },
  required: ["summary", "questions", "markingGuide"],
} as const;

/** The weekly variant, for native structured output. */
export const weeklyGenerationResponseSchema = {
  type: "object",
  properties: {
    ...generationResponseSchema.properties,
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          topicNumber: { type: "integer" },
          topicTitle: { type: "string" },
          paragraphs: { type: "array", items: { type: "integer" } },
        },
        required: ["heading", "topicNumber", "topicTitle", "paragraphs"],
      },
    },
  },
  required: ["summary", "questions", "markingGuide", "sections"],
} as const;
