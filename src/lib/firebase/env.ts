/**
 * Which Firebase configuration is missing, and how to say so.
 *
 * NO "server-only" and NO IMPORTS, deliberately - the same treatment as
 * src/lib/auth/claims.ts and lib/branding/colour.ts, and for the same reason.
 * This runs in the BROWSER bundle (firebase/client.ts) and on the SERVER
 * (firebase/admin.ts), and the two must produce the same message: a developer
 * who has half-configured their environment should not have to learn which of
 * two error styles they are looking at.
 *
 * It holds no secret and reads no environment of its own. Names of variables
 * are not values; listing the ones that are absent leaks nothing, and refusing
 * to name them is how a missing variable turns into an afternoon.
 */

/** Which half of the configuration a message is about. */
export type FirebaseConfigKind = "client" | "admin";

/**
 * The variable names whose value is absent or blank, sorted.
 *
 * Blank counts as missing. A `.env` line written `FIREBASE_PROJECT_ID=` is the
 * single most common way to half-configure this, and treating it as present
 * would hand the Firebase SDK an empty string - which fails much later, in a
 * message that names none of this.
 */
export function missingConfigKeys(config: Record<string, string | undefined>): string[] {
  return Object.entries(config)
    .filter(([, value]) => typeof value !== "string" || value.trim() === "")
    .map(([key]) => key)
    .sort();
}

/**
 * The whole refusal, ready to throw.
 *
 * NAMES EVERY MISSING VARIABLE, not just the first. Reporting them one at a
 * time turns configuring a fresh checkout into four runs of the same error, and
 * the person doing it has the file open in front of them.
 *
 * It also says explicitly that there is no default. This repo shares a Firebase
 * project with ResultPeak, which is live with a paying school, so a silent
 * fallback to a baked-in project id is not a convenience - it is how a
 * misconfigured deployment writes to a real school's database while looking
 * perfectly healthy.
 */
export function missingConfigMessage(kind: FirebaseConfigKind, missing: string[]): string {
  const where =
    kind === "client"
      ? "the browser bundle, so they must be set at BUILD time"
      : "server routes only, so they must never be prefixed NEXT_PUBLIC_";

  return (
    `Firebase is not configured: ${missing.join(", ")} ` +
    `${missing.length === 1 ? "is" : "are"} missing or blank. ` +
    `These reach ${where}. Copy .env.example to .env.local and fill them in. ` +
    `There is no default project id: this app shares a Firebase project with ` +
    `ResultPeak, and guessing one would point it at a live school's data.`
  );
}

/**
 * Throw unless every named variable has a value.
 *
 * Callers pass an object literal with the variable names as KEYS, so the error
 * can name what to go and set. Returns the same object narrowed to non-optional
 * strings, so a caller can hand it straight to initializeApp without a cast.
 */
export function assertFirebaseConfig<T extends Record<string, string | undefined>>(
  kind: FirebaseConfigKind,
  config: T
): { [K in keyof T]: string } {
  const missing = missingConfigKeys(config);
  if (missing.length) throw new Error(missingConfigMessage(kind, missing));
  return config as { [K in keyof T]: string };
}
