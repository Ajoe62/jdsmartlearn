import "server-only";
import type { GenerationResult, GradingResult } from "./schema";
import type { GradingPromptInput, PromptInput } from "./prompt";
import { generateWithGemini, gradeWithGemini } from "./gemini";

export interface GenerationMeta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  wouldBeCostUsd: number;
}

export interface GenerationResponse {
  result: GenerationResult;
  meta: GenerationMeta;
}

export interface GradingResponse {
  result: GradingResult;
  meta: GenerationMeta;
}

/**
 * Which model to spend on this call. Callers never name a model, so swapping
 * one stays a change to this file and its adapter, nothing more.
 *
 *   "fast"     short answers, where a bigger model buys nothing
 *   "quality"  longer work, where the marking guide needs actual reading
 */
export type ModelHint = "fast" | "quality";

/** Under this many characters, a heavier model adds latency and no accuracy. */
export const FAST_MODEL_THRESHOLD = 500;

/** One image, base64 encoded, for the vision path. */
export interface ImagePart {
  data: string;
  mimeType: string;
}

/**
 * THE ONLY entry point for AI generation in this codebase.
 * No provider SDK may be imported anywhere else - swapping models must stay
 * a one-file change. See CLAUDE.md.
 */
export async function generateStudyMaterials(
  input: PromptInput
): Promise<GenerationResponse> {
  const provider = process.env.AI_PROVIDER ?? "gemini";

  switch (provider) {
    case "gemini":
      return generateWithGemini(input);
    default:
      throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }
}

/**
 * THE ONLY entry point for AI marking in this codebase.
 *
 * Same contract as generateStudyMaterials: no provider SDK is imported outside
 * this file's adapters, and the caller passes a hint rather than a model name.
 *
 * The result of this call is NEVER student-visible. It lands on the submission
 * as `ai_graded` and waits for a tutor to release it (CLAUDE.md, Assessment
 * rules).
 */
export async function gradeSubmission(
  input: GradingPromptInput,
  images: ImagePart[] = []
): Promise<GradingResponse> {
  const provider = process.env.AI_PROVIDER ?? "gemini";
  const hint: ModelHint =
    input.submissionText.length < FAST_MODEL_THRESHOLD ? "fast" : "quality";

  switch (provider) {
    case "gemini":
      return gradeWithGemini(input, hint, images);
    default:
      throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }
}
