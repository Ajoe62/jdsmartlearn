import "server-only";
import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD } from "./collections";
import {
  getGeneratedContent,
  getLesson,
  getStudentLessonView,
  listVisibleLessonsForClass,
  setStudentPayload,
  toStudentPayload,
} from "./lessons";
import { getSubjects } from "./resultpeak";
import type {
  StudentLessonDetail,
  SyncIndexEntry,
  SyncLesson,
  Topic,
} from "@/types";

/**
 * Student-facing reads. Published content is CACHED so a student re-reading a
 * lesson does not re-hit Firestore - the Spark quota is shared with a live
 * paying school (see CLAUDE.md). Publishing (material or study guide)
 * invalidates the tags below.
 */

export const studentLessonsTag = (classId: string) => `student-lessons:${classId}`;
export const lessonViewTag = (lessonId: string) => `lesson-view:${lessonId}`;

const REVALIDATE_SECONDS = 300;

/**
 * How many pre-backfill lessons a single sync will repair. Bounded so a missed
 * backfill degrades slowly instead of stampeding the shared quota.
 */
const MAX_LAZY_REPAIRS = 5;

function inlineable(fileType: string | undefined): boolean {
  const t = fileType ?? "";
  return t.startsWith("application/pdf") || t.startsWith("text/");
}

/**
 * THE quota mechanism for offline sync.
 *
 * Everything a class may read, in ONE Firestore query, cached for
 * REVALIDATE_SECONDS and shared by every student in the class and by all three
 * sync routes. Thirty students syncing at 8am cost one query between them.
 *
 * Scoping is enforced INSIDE the cache and the key carries both ids, so a
 * bundle can never be served to another class or school.
 *
 * `extractedText` is deliberately absent - 200 docs x up to 800 KB would exhaust
 * the function's memory. Material text is fetched per lesson by
 * getStudentMaterial() on demand.
 */
export function getClassSyncBundle(schoolId: string, classId: string) {
  return unstable_cache(
    async (): Promise<SyncLesson[]> => {
      const [lessons, subjects] = await Promise.all([
        listVisibleLessonsForClass(schoolId, classId),
        getSubjects(schoolId),
      ]);
      const nameById = new Map(subjects.map((s) => [s.id, s.name]));

      let repairs = 0;
      const out: SyncLesson[] = [];

      for (const l of lessons) {
        let payload = l.studentPayload;

        // Published before studentPayload existed. Repair a few per sync.
        if (l.hasStudyGuide && !payload && repairs < MAX_LAZY_REPAIRS) {
          repairs++;
          const content = await getGeneratedContent(l.id);
          if (content) {
            payload = toStudentPayload(content, l.title);
            try {
              await setStudentPayload(l.id, payload);
            } catch {
              // Best effort - the student still gets this sync.
            }
          }
        }

        out.push({
          lessonId: l.id,
          title: l.title,
          topicTitle: payload?.topicTitle || l.title,
          subjectId: l.subjectId,
          subjectName: nameById.get(l.subjectId) ?? l.subjectId,
          hasMaterial: l.hasMaterial,
          // Only true when the guide is actually deliverable to a device.
          hasStudyGuide: l.hasStudyGuide && !!payload,
          updatedAt: l.updatedAt,
          studyGuide: payload
            ? { summary: payload.summary, questions: payload.questions }
            : null,
          file:
            l.hasMaterial && l.fileName
              ? {
                  name: l.fileName,
                  size: l.fileSize ?? 0,
                  inline: inlineable(l.fileType),
                }
              : null,
        });
      }

      return out;
    },
    ["student-sync", schoolId, classId],
    { tags: [studentLessonsTag(classId)], revalidate: REVALIDATE_SECONDS }
  )();
}

/**
 * The index a device syncs first: every visible lesson, minus the study-guide
 * bodies. ~150 bytes per lesson, so ~30 KB at the 200-lesson cap - one small
 * response on a bad link, and ETag-able.
 */
export async function getClassSyncIndex(
  schoolId: string,
  classId: string
): Promise<SyncIndexEntry[]> {
  const bundle = await getClassSyncBundle(schoolId, classId);
  return bundle.map(({ studyGuide: _studyGuide, ...rest }) => rest);
}

/**
 * Study-guide bodies for specific lessons, sliced out of the same cached bundle.
 * Costs no extra Firestore reads.
 */
export async function getStudyGuides(
  schoolId: string,
  classId: string,
  lessonIds: string[]
): Promise<SyncLesson[]> {
  const wanted = new Set(lessonIds);
  const bundle = await getClassSyncBundle(schoolId, classId);
  return bundle.filter((l) => wanted.has(l.lessonId));
}

/**
 * Published material text for one lesson. Cached per lesson so a whole class
 * opening the same lesson costs one read per revalidate window.
 *
 * Returns null unless the material publish switch is on - the class/school check
 * happens inside the cache, like every other student read here.
 */
export function getStudentMaterial(
  schoolId: string,
  classId: string,
  lessonId: string
) {
  return unstable_cache(
    async (): Promise<{ text: string; revision: number } | null> => {
      const lesson = await getLesson(lessonId);
      if (!lesson || lesson.schoolId !== schoolId || lesson.classId !== classId) {
        return null;
      }
      if (!lesson.materialPublishedAt) return null;
      return { text: lesson.extractedText, revision: lesson.updatedAt };
    },
    ["student-material", schoolId, classId, lessonId],
    {
      tags: [studentLessonsTag(classId), lessonViewTag(lessonId)],
      revalidate: REVALIDATE_SECONDS,
    }
  )();
}

/**
 * One lesson for a student: the material and/or the study guide, each included
 * only when its own publish switch is on. Scoping is enforced INSIDE the cache
 * (another class/school resolves to null). The marking guide is dropped by
 * getStudentLessonView - it can never reach a student here.
 */
export function getStudentLesson(schoolId: string, classId: string, lessonId: string) {
  return unstable_cache(
    async (): Promise<StudentLessonDetail | null> => {
      const lesson = await getLesson(lessonId);
      if (!lesson || lesson.schoolId !== schoolId || lesson.classId !== classId) return null;

      // The denormalized payload already carries the topic title; only fall back
      // to a topics read for pre-backfill lessons.
      let topicTitle = lesson.studentPayload?.topicTitle;
      if (!topicTitle) {
        const topicSnap = await adminDb.doc(`${JD.topics}/${lesson.topicId}`).get();
        const topic = topicSnap.data() as Topic | undefined;
        topicTitle = topic?.title ?? lesson.title;
      }

      const material = lesson.materialPublishedAt ? lesson.extractedText : null;

      // Original-file info rides with the material's publish switch.
      const file =
        material && lesson.fileKey && lesson.fileName
          ? {
              name: lesson.fileName,
              size: lesson.fileSize ?? 0,
              inline: inlineable(lesson.fileType),
            }
          : null;

      // Reuse the safe projection: returns null unless the study guide is published.
      const guide = await getStudentLessonView(lesson, topicTitle);
      const studyGuide = guide
        ? { summary: guide.summary, questions: guide.questions }
        : null;

      // Nothing published for this lesson yet - treat as not found.
      if (!material && !studyGuide) return null;

      return {
        lessonId,
        title: lesson.title,
        topicTitle,
        material,
        file,
        studyGuide,
      };
    },
    ["student-lesson", schoolId, classId, lessonId],
    {
      tags: [studentLessonsTag(classId), lessonViewTag(lessonId)],
      revalidate: REVALIDATE_SECONDS,
    }
  )();
}
