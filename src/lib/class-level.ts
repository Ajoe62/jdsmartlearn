import type { ClassLevel } from "@/types";

/**
 * Resolve a class's curriculum level.
 *
 * `classes` is ResultPeak-owned and READ ONLY - JDSmartLearn must never write a
 * `level` field onto it. So we adapt: prefer ResultPeak's stored `level` when it
 * exists, and otherwise derive it from the class name at read time. When
 * ResultPeak later adds a real `level` field, this starts using it with no code
 * change.
 */

const LEVELS: readonly ClassLevel[] = [
  "P1", "P2", "P3", "P4", "P5", "P6",
  "JSS1", "JSS2", "JSS3",
  "SS1", "SS2", "SS3",
];

// Common Nigerian class-name spellings -> canonical ClassLevel.
const ALIASES: Record<string, ClassLevel> = {
  PRIMARY1: "P1", PRIMARY2: "P2", PRIMARY3: "P3",
  PRIMARY4: "P4", PRIMARY5: "P5", PRIMARY6: "P6",
  BASIC1: "P1", BASIC2: "P2", BASIC3: "P3",
  BASIC4: "P4", BASIC5: "P5", BASIC6: "P6",
  BASIC7: "JSS1", BASIC8: "JSS2", BASIC9: "JSS3",
  JS1: "JSS1", JS2: "JSS2", JS3: "JSS3",
  SSS1: "SS1", SSS2: "SS2", SSS3: "SS3",
};

/** Best-effort level from a free-text class name, e.g. "JSS 3" -> "JSS3". */
export function levelFromClassName(name: string | undefined): ClassLevel | undefined {
  if (!name) return undefined;
  const key = name.toUpperCase().replace(/[^A-Z0-9]/g, ""); // strip spaces/dashes
  if ((LEVELS as readonly string[]).includes(key)) return key as ClassLevel;
  return ALIASES[key];
}

/** Prefer ResultPeak's stored level; fall back to deriving it from the name. */
export function classLevel(cls: { level?: ClassLevel; name?: string }): ClassLevel | undefined {
  return cls.level ?? levelFromClassName(cls.name);
}
