import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  buildGradingPrompt,
  buildPrompt,
  MAX_LESSON_CHARS,
  type GradingPromptInput,
  type PromptInput,
} from "./prompt";
import {
  generationSchema,
  generationResponseSchema,
  gradingSchema,
  gradingResponseSchema,
} from "./schema";
import { GenerationError, classifyProviderError } from "./errors";
import type { GradingResponse, GenerationResponse, ModelHint } from "./provider";

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

/**
 * Mark one submission.
 *
 * `hint` picks the model. Both currently resolve to the same flash alias, and
 * that is deliberate: the alias is the only name Google has not retired under
 * us (see the comment above), so the hint is wired through and ready rather than
 * pinned to a name that will 404 in three months. Override either with an env
 * var when there is a reason to.
 *
 * `images` are passed inline for the vision path. A photographed exercise book
 * is the common way a child hands in written work here, and there is no text
 * extractor for a photograph.
 */
export async function gradeWithGemini(
  input: GradingPromptInput,
  hint: ModelHint,
  images: { data: string; mimeType: string }[] = []
): Promise<GradingResponse> {
  const modelName =
    hint === "fast"
      ? (process.env.GEMINI_MODEL_FAST ?? process.env.GEMINI_MODEL ?? "gemini-flash-latest")
      : (process.env.GEMINI_MODEL ?? "gemini-flash-latest");

  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const { system, user } = buildGradingPrompt(input);
  const schema = gradingSchema(input.maxMarks);

  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: system,
    generationConfig: {
      responseMimeType: "application/json",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseSchema: gradingResponseSchema as any,
    },
  });

  const parts = [
    { text: user },
    ...images.map((i) => ({ inlineData: { data: i.data, mimeType: i.mimeType } })),
  ];

  const started = Date.now();
  const attempt = async () => {
    try {
      const res = await model.generateContent(parts);
      return { text: res.response.text(), usage: res.response.usageMetadata };
    } catch (e) {
      throw classifyProviderError(e);
    }
  };

  let raw = await attempt();
  let parsed = schema.safeParse(safeJson(raw.text));

  if (!parsed.success) {
    // One retry, same rule as generation. A second failure is terminal and the
    // route hands the submission to the tutor rather than guessing a mark.
    raw = await attempt();
    parsed = schema.safeParse(safeJson(raw.text));
  }

  if (!parsed.success) {
    throw new GenerationError("INVALID", "model did not return a usable mark");
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
