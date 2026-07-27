/**
 * In-memory sign-in throttle: blocks brute-forcing student access codes.
 *
 * Per serverless instance (state resets on cold start / doesn't span regions),
 * which still cuts a code-guessing loop from thousands of tries to a handful
 * per instance. Good enough for the pilot; a durable store can replace it later
 * without changing callers.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_KEYS = 10_000; // hard memory cap

type Entry = { count: number; resetAt: number };
const attempts = new Map<string, Entry>();

function prune(now: number): void {
  if (attempts.size < MAX_KEYS) return;
  for (const [key, e] of attempts) {
    if (e.resetAt <= now) attempts.delete(key);
  }
  // Still over cap after pruning expired: drop oldest entries.
  while (attempts.size >= MAX_KEYS) {
    const oldest = attempts.keys().next().value;
    if (oldest === undefined) break;
    attempts.delete(oldest);
  }
}

/** True when this key is over the limit and must wait. */
export function isThrottled(key: string): boolean {
  const e = attempts.get(key);
  if (!e) return false;
  if (Date.now() >= e.resetAt) {
    attempts.delete(key);
    return false;
  }
  return e.count >= MAX_ATTEMPTS;
}

/** Record a failed attempt. */
export function recordFailure(key: string): void {
  const now = Date.now();
  prune(now);
  const e = attempts.get(key);
  if (!e || now >= e.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    e.count += 1;
  }
}

/** Clear on success so a legitimate user isn't penalized by old typos. */
export function recordSuccess(key: string): void {
  attempts.delete(key);
}
