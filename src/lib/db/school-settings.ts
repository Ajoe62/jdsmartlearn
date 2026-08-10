import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import { sortSessionsDescending } from "@/lib/academic-calendar";
import type { AcademicSession, AcademicTerm } from "@/lib/academic-calendar";

/**
 * Per-school assessment settings.
 *
 * THIS IS A STOPGAP AND THE COMMENT IS THE POINT. Term and session are
 * ResultPeak concepts. ResultPeak does not record which term is current
 * anywhere: its terms are a hardcoded array in three frontend files, its
 * sessions are free text defaulted from `new Date().getFullYear()`, and no
 * settings document exists in the shared project. Until ResultPeak owns a
 * current-term field, JDSmartLearn holds one.
 *
 * EVERY read of the current term and session goes through
 * `getCurrentTermSession()` below. Nothing else in the codebase may read the
 * setting document directly. When ResultPeak ships its own field, that one
 * function changes and nothing else does.
 */

export interface SchoolSettings {
  schoolId: string;
  /** Verbatim from RESULTPEAK_TERMS. Never normalised. */
  term: AcademicTerm;
  /** Verbatim from the school's own data, or an explicit admin override. */
  session: AcademicSession;
  /**
   * The sessions the admin was offered when they last saved, snapshotted so the
   * write path can validate without a Firestore query. Always contains `session`.
   */
  knownSessions: AcademicSession[];
  /** True when the admin used the escape hatch to enter an unobserved session. */
  sessionIsOverride: boolean;
  /**
   * Which of the school's `assessmentTypes` the LMS feeds, by its stable `value`.
   *
   * NO DEFAULT, and never falls back. Some schools have no assignment-shaped
   * type at all: CAPSTONE ACADEMY has only first_assessment, second_assessment
   * and exam. Substituting would file a child's coursework under a column they
   * never sat, which is the exact failure ResultPeak's own `matchAssessmentType`
   * refuses. While this is null, CA sync does not run and the tutor is told so.
   */
  lmsAssessmentType: string | null;
  updatedAt: number;
  updatedBy: string;
}

/**
 * THE ONLY read of the current term and session. See the note above.
 *
 * Returns null when a school admin has not set it yet, which is a real state
 * with its own interface copy, not an error and not a reason to guess.
 */
export async function getCurrentTermSession(
  schoolId: string
): Promise<SchoolSettings | null> {
  const snap = await adminDb.doc(`${JD.schoolSettings}/${schoolId}`).get();
  return snap.exists ? ({ schoolId, ...snap.data() } as SchoolSettings) : null;
}

export async function saveSchoolSettings(
  schoolId: string,
  patch: Omit<SchoolSettings, "schoolId" | "updatedAt">
): Promise<void> {
  assertWritable(JD.schoolSettings);
  await adminDb
    .doc(`${JD.schoolSettings}/${schoolId}`)
    .set({ schoolId, ...patch, updatedAt: Date.now() }, { merge: true });
}

/** One observed academic session, with enough context for an admin to choose. */
export interface ObservedSession {
  session: AcademicSession;
  /** How many exams and results carry it. */
  count: number;
  /** Most recent use, epoch ms, or null when neither source carried a date. */
  lastUsedAt: number | null;
}

/**
 * The academic sessions this school's ResultPeak data actually contains.
 *
 * COLD PATH ONLY. Two ResultPeak reads, both equality-filtered on `schoolId` and
 * both limited, run when a school admin opens the settings form. Never on a
 * write path, never on a student route.
 *
 * Grounding the admin's choice in observed data rather than in what is
 * calendrically correct is deliberate. ResultPeak's `defaultSession()` returns
 * the NEXT session from January to August, so a school's live results already
 * sit under a session string that is factually wrong. A correct string would not
 * join to them. The string exists to join, not to be right.
 *
 * Reads only. `exams` and `results` are ResultPeak-owned.
 */
export async function observedSessions(schoolId: string): Promise<ObservedSession[]> {
  const [exams, results] = await Promise.all([
    adminDb
      .collection(RP.exams)
      .where("schoolId", "==", schoolId)
      .select("academicSession", "createdAt")
      .limit(QUERY_LIMIT)
      .get(),
    adminDb
      .collection(RP.results)
      .where("schoolId", "==", schoolId)
      .select("academicSession", "submittedAtMs")
      .limit(QUERY_LIMIT)
      .get(),
  ]);

  const tally = new Map<string, { count: number; lastUsedAt: number | null }>();

  const record = (session: unknown, at: number | null) => {
    if (typeof session !== "string" || session === "") return;
    const current = tally.get(session) ?? { count: 0, lastUsedAt: null };
    tally.set(session, {
      count: current.count + 1,
      lastUsedAt:
        at === null ? current.lastUsedAt : Math.max(current.lastUsedAt ?? 0, at),
    });
  };

  for (const doc of exams.docs) {
    const data = doc.data();
    // Firestore Timestamp on exams; results carry epoch ms instead.
    const createdAt = data.createdAt;
    const at =
      createdAt && typeof createdAt.toMillis === "function"
        ? (createdAt.toMillis() as number)
        : null;
    record(data.academicSession, at);
  }

  for (const doc of results.docs) {
    const data = doc.data();
    const at = typeof data.submittedAtMs === "number" ? data.submittedAtMs : null;
    record(data.academicSession, at);
  }

  return sortSessionsDescending([...tally.keys()]).map((session) => {
    // Present because the key came from the map's own keys.
    const entry = tally.get(session) as { count: number; lastUsedAt: number | null };
    return { session, count: entry.count, lastUsedAt: entry.lastUsedAt };
  });
}
