import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { JD, QUERY_LIMIT } from "./collections";
import { assertWritable } from "./write-guard";
import type {
  GeneratedContent,
  Lesson,
  StudentLessonView,
  StudentPayload,
} from "@/types";

export async function createLesson(
  data: Omit<Lesson, "id" | "createdAt" | "updatedAt">
): Promise<string> {
  assertWritable(JD.lessons);
  const now = Date.now();
  const ref = await adminDb
    .collection(JD.lessons)
    .add({ ...data, createdAt: now, updatedAt: now });
  return ref.id;
}

export async function getLesson(lessonId: string): Promise<Lesson | null> {
  const snap = await adminDb.doc(`${JD.lessons}/${lessonId}`).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Lesson) : null;
}

/** Every lesson in a school (admin view). One equality filter, sorted in memory. */
export async function listLessonsForSchool(schoolId: string) {
  const snap = await adminDb
    .collection(JD.lessons)
    .where("schoolId", "==", schoolId)
    .select("title", "className", "classId", "subjectId", "tutorId", "status", "publishedAt", "materialPublishedAt", "updatedAt")
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Lesson)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Two equality filters, no orderBy - needs NO composite index (sorted in memory). */
export async function listLessonsForTutor(schoolId: string, tutorId: string) {
  const snap = await adminDb
    .collection(JD.lessons)
    .where("schoolId", "==", schoolId)
    .where("tutorId", "==", tutorId)
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Lesson)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export type VisibleLesson = {
  id: string;
  title: string;
  subjectId: string;
  /** Raw material published to students. */
  hasMaterial: boolean;
  /** AI study guide published to students. */
  hasStudyGuide: boolean;
  /** Device staleness key - a changed value means "re-download this lesson". */
  updatedAt: number;
  /** Denormalized study guide. Absent on lessons published before the backfill. */
  studentPayload?: StudentPayload;
  /** Original-file metadata, if one was uploaded. */
  fileName?: string;
  fileSize?: number;
  fileType?: string;
};

/**
 * Lessons a student may see in a class: material OR study guide published.
 * Two equality filters, filtered/sorted in memory - needs NO composite index.
 *
 * `.select()` is what keeps this affordable: `studentPayload` (a few KB) rides
 * along so a class sync needs no follow-up reads, while `extractedText` (up to
 * 800 KB x 200 docs) stays out. Material text is fetched per lesson on demand.
 */
export async function listVisibleLessonsForClass(
  schoolId: string,
  classId: string
): Promise<VisibleLesson[]> {
  const snap = await adminDb
    .collection(JD.lessons)
    .where("schoolId", "==", schoolId)
    .where("classId", "==", classId)
    .select(
      "title",
      "subjectId",
      "status",
      "publishedAt",
      "materialPublishedAt",
      "updatedAt",
      "studentPayload",
      "fileName",
      "fileSize",
      "fileType"
    )
    .limit(QUERY_LIMIT)
    .get();
  return snap.docs
    .map((d) => {
      const x = d.data() as {
        title: string;
        subjectId: string;
        status?: string;
        publishedAt?: number;
        materialPublishedAt?: number;
        updatedAt?: number;
        studentPayload?: StudentPayload;
        fileName?: string;
        fileSize?: number;
        fileType?: string;
      };
      return {
        id: d.id,
        title: x.title,
        subjectId: x.subjectId,
        hasMaterial: !!x.materialPublishedAt,
        hasStudyGuide: x.status === "published",
        updatedAt: x.updatedAt ?? 0,
        studentPayload: x.studentPayload,
        fileName: x.fileName,
        fileSize: x.fileSize,
        fileType: x.fileType,
        _sortAt: Math.max(x.publishedAt ?? 0, x.materialPublishedAt ?? 0),
      };
    })
    .filter((l) => l.hasMaterial || l.hasStudyGuide)
    .sort((a, b) => b._sortAt - a._sortAt)
    .map(
      (l): VisibleLesson => ({
        id: l.id,
        title: l.title,
        subjectId: l.subjectId,
        hasMaterial: l.hasMaterial,
        hasStudyGuide: l.hasStudyGuide,
        updatedAt: l.updatedAt,
        studentPayload: l.studentPayload,
        fileName: l.fileName,
        fileSize: l.fileSize,
        fileType: l.fileType,
      })
    );
}

/**
 * Edit a lesson's own fields after creation. Only these four are editable -
 * status/publish flags have their own routes, and everything else is identity.
 * classId/className must be set together (denormalized pair).
 */
export async function updateLessonDetails(
  lessonId: string,
  patch: Partial<Pick<Lesson, "title" | "extractedText" | "classId" | "className">>
): Promise<void> {
  assertWritable(JD.lessons);
  await adminDb.doc(`${JD.lessons}/${lessonId}`).update({ ...patch, updatedAt: Date.now() });
}

/** Attach stored-file metadata to a lesson (set after the R2 upload succeeds). */
export async function setLessonFile(
  lessonId: string,
  file: { fileKey: string; fileName: string; fileSize: number; fileType: string }
): Promise<void> {
  assertWritable(JD.lessons);
  await adminDb.doc(`${JD.lessons}/${lessonId}`).update({ ...file, updatedAt: Date.now() });
}

/**
 * Delete a lesson and everything hanging off it (generated content, read
 * receipts). Batched deletes, looped in bounded pages to stay within limits.
 */
export async function deleteLesson(lessonId: string): Promise<void> {
  assertWritable(JD.lessons);
  assertWritable(JD.generatedContent);
  assertWritable(JD.lessonViews);

  for (const coll of [JD.generatedContent, JD.lessonViews]) {
    // Page through children (bounded per iteration; loop until drained).
    for (;;) {
      const snap = await adminDb
        .collection(coll)
        .where("lessonId", "==", lessonId)
        .limit(200)
        .get();
      if (snap.empty) break;
      const batch = adminDb.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < 200) break;
    }
  }

  await adminDb.doc(`${JD.lessons}/${lessonId}`).delete();
}

/** Publish or hide the raw lesson material for students. Independent of the study guide. */
export async function setMaterialPublished(lessonId: string, published: boolean) {
  assertWritable(JD.lessons);
  await adminDb.doc(`${JD.lessons}/${lessonId}`).update({
    materialPublishedAt: published ? Date.now() : null,
    updatedAt: Date.now(),
  });
}

/**
 * Latest generated content for a lesson. Single equality filter, no orderBy -
 * needs NO composite index. A lesson has only a handful of versions (regenerate
 * is rare, capped daily), so we fetch them and pick the newest in memory.
 */
export async function getGeneratedContent(lessonId: string): Promise<GeneratedContent | null> {
  const snap = await adminDb
    .collection(JD.generatedContent)
    .where("lessonId", "==", lessonId)
    .limit(50)
    .get();
  if (snap.empty) return null;
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as GeneratedContent)
    .sort((a, b) => b.version - a.version)[0];
}

/**
 * The ONLY constructor for StudentPayload.
 *
 * It names each safe field deliberately. Do NOT rewrite this as a spread of
 * `content` - that would copy markingGuide onto the lesson doc, from where it
 * would reach every student device in the class. This one function is why the
 * offline store cannot leak a marking guide (see docs/OFFLINE-FIRST.md).
 */
export function toStudentPayload(
  content: Pick<GeneratedContent, "summary" | "questions">,
  topicTitle: string
): StudentPayload {
  return {
    summary: content.summary,
    questions: content.questions,
    topicTitle,
    revision: Date.now(),
  };
}

/** Attach the student-safe study guide to a lesson (called on publish). */
export async function setStudentPayload(
  lessonId: string,
  payload: StudentPayload
): Promise<void> {
  assertWritable(JD.lessons);
  await adminDb
    .doc(`${JD.lessons}/${lessonId}`)
    .update({ studentPayload: payload, updatedAt: Date.now() });
}

/**
 * Remove the denormalized guide (called on unpublish). Deleting the field rather
 * than nulling it keeps `studentPayload === undefined` the single "not published"
 * signal for the sync bundle.
 */
export async function clearStudentPayload(lessonId: string): Promise<void> {
  assertWritable(JD.lessons);
  await adminDb.doc(`${JD.lessons}/${lessonId}`).update({
    studentPayload: FieldValue.delete(),
    updatedAt: Date.now(),
  });
}

/**
 * Student-safe projection. The marking guide is dropped HERE so it cannot
 * leak through a route that forgets to strip it.
 *
 * Reads the denormalized `studentPayload` when present - that costs zero extra
 * reads. Falls back to generatedContent only for lessons published before the
 * backfill, and repairs them on the way past.
 */
export async function getStudentLessonView(
  lesson: Lesson,
  topicTitle: string
): Promise<StudentLessonView | null> {
  if (lesson.status !== "published") return null;

  if (lesson.studentPayload) {
    return {
      lessonId: lesson.id,
      title: lesson.title,
      topicTitle: lesson.studentPayload.topicTitle || topicTitle,
      summary: lesson.studentPayload.summary,
      questions: lesson.studentPayload.questions,
    };
  }

  // Pre-backfill lesson: resolve the slow way once, then denormalize so the next
  // read is free. A failed repair must not fail the read.
  const content = await getGeneratedContent(lesson.id);
  if (!content) return null;

  const payload = toStudentPayload(content, topicTitle);
  try {
    await setStudentPayload(lesson.id, payload);
  } catch {
    // Best effort - the student still gets their lesson.
  }

  return {
    lessonId: lesson.id,
    title: lesson.title,
    topicTitle,
    summary: payload.summary,
    questions: payload.questions,
  };
}

/** UTC day, e.g. "2026-07-22". Stored on audit logs so the daily cap can be an
 *  equality filter instead of a range (which would force a composite index). */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Daily generation cap per tutor - protects free-tier quota and unit economics.
 * Four equality filters (incl. today's dateKey), no range - needs NO composite index.
 */
export async function countGenerationsToday(schoolId: string, tutorId: string) {
  const snap = await adminDb
    .collection(JD.auditLogs)
    .where("schoolId", "==", schoolId)
    .where("actorUid", "==", tutorId)
    .where("action", "==", "lesson.generate")
    .where("dateKey", "==", dayKey(Date.now()))
    .limit(50)
    .get();
  return snap.size;
}

export async function writeAuditLog(entry: {
  schoolId: string;
  actorUid: string;
  action: string;
  entityId: string;
  /** Optional short context, e.g. which fields an edit touched. */
  detail?: string;
}) {
  assertWritable(JD.auditLogs);
  const createdAt = Date.now();
  await adminDb
    .collection(JD.auditLogs)
    .add({ ...entry, createdAt, dateKey: dayKey(createdAt) });
}
