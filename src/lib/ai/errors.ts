/** Typed generation failures so routes can respond specifically (see provider.ts). */
export type GenerationErrorCode = "RATE_LIMITED" | "INVALID" | "FAILED";

export class GenerationError extends Error {
  code: GenerationErrorCode;
  constructor(code: GenerationErrorCode, message: string) {
    super(message);
    this.name = "GenerationError";
    this.code = code;
  }
}

/** Map a raw provider error to our taxonomy. */
export function classifyProviderError(e: unknown): GenerationError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b429\b|too many requests|quota|rate limit/i.test(msg)) {
    return new GenerationError("RATE_LIMITED", msg);
  }
  return new GenerationError("FAILED", msg);
}
