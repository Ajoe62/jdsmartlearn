import type { ClassLevel } from "@/types";

/**
 * Resolve a class's curriculum level.
 *
 * `classes` is ResultPeak-owned and READ ONLY - JDSmartLearn must never write a
 * `level` field onto it. So we adapt: prefer ResultPeak's stored `level` when it
 * exists, and otherwise derive it from the class name at read time. When
 * ResultPeak later adds a real `level` field, this starts using it with no code
 * change.
 *
 * ResultPeak's `cadre` field does not help here: it is "primary" on nursery and
 * pre-nursery classes too, so the name is the only signal that tells them apart.
 */

/**
 * Every level, youngest first, with the name a teacher reads.
 *
 * THE ONE LIST. A Record keyed by ClassLevel, so adding a level to the type
 * without naming it here fails the build. The topics route, the lesson form and
 * the AI reading bands all read from this. Until 2026-09-13 there were three
 * hand-kept copies that stopped at Primary 1, so nursery classes had no level at
 * all; pre-nursery and nursery were added then, on the owner's decision.
 */
export const LEVEL_LABELS: Record<ClassLevel, string> = {
  PN: "Pre-nursery",
  N1: "Nursery 1",
  N2: "Nursery 2",
  N3: "Nursery 3",
  P1: "Primary 1",
  P2: "Primary 2",
  P3: "Primary 3",
  P4: "Primary 4",
  P5: "Primary 5",
  P6: "Primary 6",
  JSS1: "JSS 1",
  JSS2: "JSS 2",
  JSS3: "JSS 3",
  SS1: "SS 1",
  SS2: "SS 2",
  SS3: "SS 3",
};

/** Youngest first. Object key order is insertion order for these keys. */
export const CLASS_LEVELS = Object.keys(LEVEL_LABELS) as ClassLevel[];

export function isClassLevel(value: unknown): value is ClassLevel {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(LEVEL_LABELS, value)
  );
}

/** Pre-nursery and nursery: children who cannot read yet. */
export function isEarlyYears(level: ClassLevel): boolean {
  return level === "PN" || level === "N1" || level === "N2" || level === "N3";
}

// Common Nigerian class-name spellings -> canonical ClassLevel.
const ALIASES: Record<string, ClassLevel> = {
  PRENURSERY: "PN", TODDLER: "PN", TODDLERS: "PN", PLAYGROUP: "PN", CRECHE: "PN",
  NURSERY1: "N1", NURSERY2: "N2", NURSERY3: "N3",
  NUR1: "N1", NUR2: "N2", NUR3: "N3",
  // A British-curriculum school's Reception is its Nursery 3 - Mt Cedar lists
  // the two as one admissions level, "Nursery 3/Reception".
  RECEPTION: "N3",
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
  if (isClassLevel(key)) return key;
  if (ALIASES[key]) return ALIASES[key];

  // Early-years classes are often named twice over or with an arm:
  // "Toddlers/Pre-nursery", "Nursery 3/Reception", "Nursery 1A". Matched on the
  // leading word only, and never a guess across stages - "KG" is left
  // unresolved because schools disagree about which nursery year it means.
  if (/^(TODDLERS?|PRENURSERY|PLAYGROUP|CRECHE)/.test(key)) return "PN";
  const nursery = /^NURSERY([123])(?![0-9])/.exec(key);
  if (nursery) return `N${nursery[1]}` as ClassLevel;

  return undefined;
}

/** Prefer ResultPeak's stored level; fall back to deriving it from the name. */
export function classLevel(cls: { level?: ClassLevel; name?: string }): ClassLevel | undefined {
  return cls.level ?? levelFromClassName(cls.name);
}
