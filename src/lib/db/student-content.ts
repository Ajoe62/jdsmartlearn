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
  Lesson,
  NoteSection,
  NoteTopic,
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
          topicTitle: payload?.topicTitle || l.topicTitle || l.title,
          kind: l.kind,
          week: l.week,
          topics: noteTopics(l.kind, payload?.topics, payload?.topicTitle || l.topicTitle || l.title),
          // Only when the guide is deliverable: sections publish with it.
          hasSections: l.hasStudyGuide && !!payload && (payload.sectionCount ?? 0) > 0,
          subjectId: l.subjectId,
          subjectName: nameById.get(l.subjectId) ?? l.subjectId,
          hasMaterial: l.hasMaterial,
          // Only true when the guide is actually deliverable to a device.
          hasStudyGuide: l.hasStudyGuide && !!payload,
          updatedAt: l.updatedAt,
          term: l.term,
          session: l.session,
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
 * The topic labels a note is shelved under. A guide published before
 * 2026-10-02 carries no list, and a material-only note no guide at all; both
 * are shelved under the single title they always showed.
 *
 * EXCEPT a weekly note, whose topics exist only once its sorting is reviewed
 * and published. Until then it has none, rather than appearing under "By
 * topic" as a topic called "Week Three Mathematics notes".
 */
function noteTopics(
  kind: "weekly" | "topic" | undefined,
  topics: NoteTopic[] | undefined,
  fallback: string
): NoteTopic[] {
  if (topics && topics.length > 0) return topics;
  return kind === "weekly" ? [] : [{ id: null, title: fallback }];
}

/**
 * A weekly note's approved topic sections, or null. Gated on the STUDY GUIDE's
 * publish switch, because sections are reviewed and published with it - a note
 * whose guide is withdrawn has no sections to show, whatever the field holds.
 */
function publishedSections(lesson: Lesson): NoteSection[] | null {
  if (lesson.status !== "published") return null;
  return lesson.studentSections && lesson.studentSections.length > 0
    ? lesson.studentSections
    : null;
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
 * One lesson's BODY - its published material text and, on a weekly note, its
 * published topic sections - so a device can save it for offline reading.
 * Cached per lesson so a whole class opening the same lesson costs one read per
 * revalidate window.
 *
 * Each half follows its own publish switch: `text` is null unless the material
 * is published, `sections` null unless the study guide is. Returns null when
 * neither is - the class/school check happens inside the cache, like every
 * other student read here.
 *
 * Sections travel here rather than in the class bundle for the size reason on
 * Lesson.studentSections.
 */
export function getStudentMaterial(
  schoolId: string,
  classId: string,
  lessonId: string
) {
  return unstable_cache(
    async (): Promise<{
      text: string | null;
      sections: NoteSection[] | null;
      revision: number;
    } | null> => {
      const lesson = await getLesson(lessonId);
      if (!lesson || lesson.schoolId !== schoolId || lesson.classId !== classId) {
        return null;
      }
      const text = lesson.materialPublishedAt ? (lesson.extractedText ?? "") : null;
      const sections = publishedSections(lesson);
      if (text === null && !sections) return null;
      return { text, sections, revision: lesson.updatedAt };
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
      let topicTitle = lesson.studentPayload?.topicTitle || lesson.topicTitle;
      if (!topicTitle) {
        const topicSnap = lesson.topicId
          ? await adminDb.doc(`${JD.topics}/${lesson.topicId}`).get()
          : null;
        const topic = topicSnap?.data() as Topic | undefined;
        topicTitle = topic?.title ?? lesson.title;
      }

      /**
       * "" IS A REAL ANSWER HERE. A lesson whose original is a scan, a slide
       * deck or a photo has no text; its material is the file alone. So test
       * for null (unpublished), never for falsiness, or a published file-only
       * lesson would vanish from the student's screen.
       */
      const material = lesson.materialPublishedAt ? (lesson.extractedText ?? "") : null;

      // Original-file info rides with the material's publish switch.
      const file =
        material !== null && lesson.fileKey && lesson.fileName
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
      if (material === null && !studyGuide) return null;

      return {
        lessonId,
        title: lesson.title,
        topicTitle,
        kind: lesson.kind === "weekly" ? "weekly" : "topic",
        week: typeof lesson.week === "number" ? lesson.week : null,
        topics: noteTopics(lesson.kind, guide ? lesson.studentPayload?.topics : undefined, topicTitle),
        sections: guide ? publishedSections(lesson) : null,
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
