import "server-only";
import { unstable_cache, revalidateTag } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD, LIST_LIMIT, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import type { Scheme, StudentScheme, StudentSchemeSummary } from "@/types/schemes";

/**
 * Schemes of work.
 *
 * Every query is equality-only, `.limit()`ed and sorted in memory - the rule
 * that keeps this repo free of composite indexes on a project shared with a live
 * paying school. See docs/firestore-indexes-to-append.md before adding one.
 *
 * NOTHING HERE CALLS THE AI PROVIDER, and nothing should. A scheme is the
 * school's own curriculum document; summarising it would invent curriculum, and
 * it must not spend the daily generation cap (CLAUDE.md, Scheme of work rules).
 */

export const schemesTag = (classId: string) => `schemes:${classId}`;

const REVALIDATE_SECONDS = 300;

function inlineable(fileType: string | undefined): boolean {
  const t = fileType ?? "";
  return t.startsWith("application/pdf") || t.startsWith("text/") || t.startsWith("image/");
}

export async function createScheme(
  data: Omit<Scheme, "id" | "createdAt" | "updatedAt">
): Promise<string> {
  assertWritable(JD.schemes);
  const now = Date.now();
  const ref = await adminDb
    .collection(JD.schemes)
    .add({ ...data, createdAt: now, updatedAt: now });
  if (data.publishedAt) revalidateTag(schemesTag(data.classId));
  return ref.id;
}

export async function getScheme(id: string): Promise<Scheme | null> {
  const snap = await adminDb.doc(`${JD.schemes}/${id}`).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Scheme) : null;
}

/** Attach stored-file metadata after the R2 upload succeeds. */
export async function setSchemeFile(
  id: string,
  file: { fileKey: string; fileName: string; fileSize: number; fileType: string }
): Promise<void> {
  assertWritable(JD.schemes);
  await adminDb.doc(`${JD.schemes}/${id}`).update({ ...file, updatedAt: Date.now() });
}

/**
 * Publish or withdraw. One switch, and it is the only thing that makes a scheme
 * student-visible.
 */
export async function setSchemePublished(
  id: string,
  classId: string,
  published: boolean
): Promise<void> {
  assertWritable(JD.schemes);
  await adminDb.doc(`${JD.schemes}/${id}`).update({
    publishedAt: published ? Date.now() : null,
    updatedAt: Date.now(),
  });
  revalidateTag(schemesTag(classId));
}

export async function updateScheme(
  id: string,
  classId: string,
  patch: Partial<Pick<Scheme, "title" | "extractedText" | "weeks" | "term" | "session">>
): Promise<void> {
  assertWritable(JD.schemes);
  await adminDb.doc(`${JD.schemes}/${id}`).update({ ...patch, updatedAt: Date.now() });
  revalidateTag(schemesTag(classId));
}

export async function deleteScheme(id: string, classId: string): Promise<void> {
  assertWritable(JD.schemes);
  await adminDb.doc(`${JD.schemes}/${id}`).delete();
  revalidateTag(schemesTag(classId));
}

/** Everything a tutor has uploaded. Two equality filters, sorted in memory. */
export async function listSchemesForTutor(
  schoolId: string,
  tutorId: string
): Promise<Scheme[]> {
  const snap = await adminDb
    .collection(JD.schemes)
    .where("schoolId", "==", schoolId)
    .where("tutorId", "==", tutorId)
    .select(
      "classId", "className", "subjectId", "subjectName", "tutorId", "schoolId",
      "title", "term", "session", "publishedAt", "fileName", "fileSize",
      "fileType", "createdAt", "updatedAt"
    )
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Scheme)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Every scheme across a set of classes, published or not. For the tutor's
 * schemes screen, which lists one row per (class, subject) they teach.
 *
 * ONE equality filter on `schoolId`, with the class filter applied in memory.
 * Deliberately not `where('classId', 'in', ids)`: `in` caps at 30 values, so an
 * admin at a school with more than thirty classes would silently see a partial
 * list - the worst failure mode for a screen whose entire purpose is showing
 * what is MISSING. The result is bounded by QUERY_LIMIT, and a school's schemes
 * are roughly classes x subjects, which sits well inside it.
 */
export async function listSchemesForSchoolClasses(
  schoolId: string,
  classIds: string[]
): Promise<Scheme[]> {
  if (classIds.length === 0) return [];
  const wanted = new Set(classIds);

  const snap = await adminDb
    .collection(JD.schemes)
    .where("schoolId", "==", schoolId)
    .select(
      "classId", "className", "subjectId", "subjectName", "tutorId", "schoolId",
      "title", "term", "session", "publishedAt", "fileName", "fileSize",
      "fileType", "createdAt", "updatedAt"
    )
    .limit(QUERY_LIMIT)
    .get();

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Scheme)
    .filter((s) => wanted.has(s.classId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every scheme in a class, published or not. For the tutor's class view. */
export async function listSchemesForClass(
  schoolId: string,
  classId: string
): Promise<Scheme[]> {
  const snap = await adminDb
    .collection(JD.schemes)
    .where("schoolId", "==", schoolId)
    .where("classId", "==", classId)
    .select(
      "classId", "className", "subjectId", "subjectName", "tutorId", "schoolId",
      "title", "term", "session", "publishedAt", "fileName", "fileSize",
      "fileType", "createdAt", "updatedAt"
    )
    .limit(LIST_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Scheme)
    .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

/**
 * Published schemes for a class, CACHED and shared by the whole class - the same
 * mechanism `getClassSyncBundle` uses, for the same reason.
 *
 * `extractedText` and `weeks` are deliberately absent: a scheme document can be
 * hundreds of KB and a class may have a dozen. The body is fetched per scheme by
 * `getStudentScheme()` when a child actually opens one.
 */
export function listPublishedSchemesForClass(schoolId: string, classId: string) {
  return unstable_cache(
    async (): Promise<Scheme[]> => {
      const snap = await adminDb
        .collection(JD.schemes)
        .where("schoolId", "==", schoolId)
        .where("classId", "==", classId)
        .select(
          "classId", "className", "subjectId", "subjectName", "tutorId", "schoolId",
          "title", "term", "session", "publishedAt", "fileName", "fileSize",
          "fileType", "createdAt", "updatedAt"
        )
        .limit(LIST_LIMIT)
        .get();
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }) as Scheme)
        .filter((s) => !!s.publishedAt)
        .sort((a, b) => a.subjectName.localeCompare(b.subjectName));
    },
    ["published-schemes", schoolId, classId],
    { tags: [schemesTag(classId)], revalidate: REVALIDATE_SECONDS }
  )();
}

/**
 * The safe projection. Names its fields, so `tutorId` and `fileKey` have nowhere
 * to land - see the note on StudentScheme.
 */
export function toStudentScheme(s: Scheme): StudentScheme {
  return {
    schemeId: s.id,
    title: s.title,
    subjectId: s.subjectId,
    subjectName: s.subjectName,
    term: s.term,
    session: s.session,
    text: s.extractedText,
    weeks: s.weeks ?? [],
    file:
      s.fileName
        ? { name: s.fileName, size: s.fileSize ?? 0, inline: inlineable(s.fileType) }
        : null,
    updatedAt: s.updatedAt,
  };
}

/** The index projection: a shelf row, without the body. */
export function toSchemeSummary(s: Scheme): StudentSchemeSummary {
  const { text: _text, weeks, ...rest } = toStudentScheme(s);
  return { ...rest, hasWeeks: weeks.length > 0 };
}

/**
 * One published scheme for a student, scoped INSIDE the cache so another class's
 * scheme resolves to null rather than being filtered afterwards.
 */
export function getStudentScheme(schoolId: string, classId: string, schemeId: string) {
  return unstable_cache(
    async (): Promise<StudentScheme | null> => {
      const scheme = await getScheme(schemeId);
      if (!scheme) return null;
      if (scheme.schoolId !== schoolId || scheme.classId !== classId) return null;
      // A draft is not a student's to read, however it was linked to.
      if (!scheme.publishedAt) return null;
      return toStudentScheme(scheme);
    },
    ["student-scheme", schoolId, classId, schemeId],
    { tags: [schemesTag(classId)], revalidate: REVALIDATE_SECONDS }
  )();
}
