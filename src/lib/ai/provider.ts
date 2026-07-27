import "server-only";
import type { GenerationResult } from "./schema";
import type { PromptInput } from "./prompt";
import { generateWithGemini } from "./gemini";

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
