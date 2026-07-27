import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (student access codes).
 * Both sides are SHA-256 hashed first so the comparison length is fixed -
 * neither content nor length differences change the timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
