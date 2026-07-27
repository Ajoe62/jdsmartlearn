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

export type GenerationResult = z.infer<typeof generationSchema>;

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
