import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildPrompt, MAX_LESSON_CHARS, type PromptInput } from "./prompt";
import { generationSchema, generationResponseSchema } from "./schema";
import { GenerationError, classifyProviderError } from "./errors";
import type { GenerationResponse } from "./provider";

/** Free tier today; kept so unit economics are known before the tier is outgrown. */
const RATE_PER_M_INPUT_USD = 0.1;
const RATE_PER_M_OUTPUT_USD = 0.4;

export async function generateWithGemini(input: PromptInput): Promise<GenerationResponse> {
  // Use the alias, not a pinned version: Google keeps retiring pinned names for
  // new projects (2.0-flash quota=0, 2.5-flash withdrawn). The alias always
  // resolves to the currently-served flash model.
  const modelName = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

  const lessonText = input.lessonText.slice(0, MAX_LESSON_CHARS);
  const { system, user } = buildPrompt({ ...input, lessonText });

  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: system,
    generationConfig: {
      responseMimeType: "application/json",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseSchema: generationResponseSchema as any,
    },
  });

  const started = Date.now();
  const attempt = async () => {
    try {
      const res = await model.generateContent(user);
      return {
        text: res.response.text(),
        usage: res.response.usageMetadata,
      };
    } catch (e) {
      // Turn provider errors (e.g. 429 quota) into our taxonomy so the route
      // can tell the tutor what actually happened.
      throw classifyProviderError(e);
    }
  };

  let raw = await attempt();
  let parsed = generationSchema.safeParse(safeJson(raw.text));

  if (!parsed.success) {
    // One retry, per CLAUDE.md, then surface a friendly error upstream.
    raw = await attempt();
    parsed = generationSchema.safeParse(safeJson(raw.text));
  }

  if (!parsed.success) {
    throw new GenerationError(
      "INVALID",
      "model did not return usable study materials"
    );
  }

  const inputTokens = raw.usage?.promptTokenCount ?? 0;
  const outputTokens = raw.usage?.candidatesTokenCount ?? 0;

  return {
    result: parsed.data,
    meta: {
      model: modelName,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
      wouldBeCostUsd:
        (inputTokens / 1e6) * RATE_PER_M_INPUT_USD +
        (outputTokens / 1e6) * RATE_PER_M_OUTPUT_USD,
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}
