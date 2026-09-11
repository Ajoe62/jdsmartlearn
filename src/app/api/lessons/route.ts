import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP } from "@/lib/db/collections";
import {
  getTutorSession,
  assertClassAccess,
  assertSubjectAccess,
} from "@/lib/auth/tutor";
import { MIN_USABLE_CHARS } from "@/lib/extract/text";
import {
  createLesson,
  newLessonId,
  setMaterialPublished,
  writeAuditLog,
} from "@/lib/db/lessons";
import { studentLessonsTag } from "@/lib/db/student-content";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { lessonFileKey } from "@/lib/storage/keys";
import {
  UploadError,
  claimUpload,
  discardClaimed,
  fileFields,
  readClaimedText,
  tutorActor,
  type ClaimedFile,
} from "@/lib/storage/uploads";
import type { ResultPeakClass, Topic } from "@/types";

export const maxDuration = 60;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Create a lesson from pasted text, an uploaded file, or both. The original file
 * is kept in R2 alongside the extracted text; text stays the student-facing
 * default.
 *
 * THE FILE NEVER COMES THROUGH HERE. The browser has already put it in R2
 * (lib/upload-client.ts) and sends its staging key as `uploadKey`; this route
 * claims it only after the class and subject checks below. A Vercel function
 * refuses request bodies over 4.5 MB, which is what broke every larger upload
 * before direct uploads existed.
 *
 * A FILE WITH NO READABLE TEXT IS STILL A LESSON (owner's decision,
 * 2026-09-11). A scanned PDF, a slide deck or a photo is kept as the original,
 * students open it once the material is published, and the study guide waits
 * until the tutor adds the text - /generate refuses without it.
 *
 * Still multipart, because the offline outbox posts text-only creates here in
 * that shape (lib/offline/tutor-outbox.ts) and must keep working unchanged.
 */
export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const form = await req.formData().catch(() => null);
  if (!form) return bad("We couldn't read that. Reload the page and try again.");

  const classId = String(form.get("classId") ?? "");
  const topicId = String(form.get("topicId") ?? "");
  const title = String(form.get("title") ?? "").trim();
  const pasted = String(form.get("text") ?? "").trim();
  const uploadKey = form.get("uploadKey");
  const fileName = form.get("fileName");
  /**
   * Publish the raw material as soon as the lesson lands.
   *
   * Exists so an offline-queued "create then publish material" collapses into one
   * request (see lib/offline/collapse.ts) instead of needing a dependent op that
   * waits for the server to assign an id. Study-guide publishing is untouched -
   * that still requires generation and the mandatory review gate.
   */
  const publishMaterial = String(form.get("publishMaterial") ?? "") === "true";

  /**
   * A page loaded before direct uploads existed posts the file itself. Say so,
   * rather than taking a small file and letting a large one die at the
   * platform's 4.5 MB limit with an error the tutor cannot read.
   */
  if (form.get("file") instanceof File) {
    return bad("This page is out of date. Reload it, then choose the file again.");
  }

  if (!title || !classId || !topicId) {
    return bad("Add a title and choose a class and topic.");
  }

  try {
    assertClassAccess(session, classId);
  } catch {
    return bad("You don't teach that class.", 403);
  }

  /**
   * Derive the topic and class facts server-side instead of trusting the form.
   *
   * The client used to supply subjectId and className verbatim, which meant a
   * lesson could be tagged with another school's topic (it is read straight into
   * the AI prompt) or given a spoofed class name. Both are denormalized onto the
   * lesson and would ride out to every student device.
   */
  const [topicSnap, classSnap] = await Promise.all([
    adminDb.doc(`${JD.topics}/${topicId}`).get(),
    adminDb.doc(`${RP.classes}/${classId}`).get(),
  ]);

  const topic = topicSnap.data() as Topic | undefined;
  if (!topic || topic.schoolId !== session.schoolId) {
    return bad("That topic isn't available.");
  }

  const cls = classSnap.data() as ResultPeakClass | undefined;
  if (!cls || cls.schoolId !== session.schoolId) {
    return bad("That class isn't available.");
  }

  // Trust the topic for the subject and the roster for the display name.
  const subjectId = topic.subjectId;
  const className = cls.name;

  /**
   * The subject check has to be HERE, not beside assertClassAccess above: the
   * client never sends a subject, it sends a topic, and the subject is whatever
   * that topic carries. Choosing another subject's topic is how a tutor would
   * otherwise create a lesson outside their allocation.
   */
  try {
    assertSubjectAccess(session, classId, subjectId);
  } catch {
    return bad("You don't teach that subject to that class.", 403);
  }

  const hasUpload = typeof uploadKey === "string" && uploadKey.length > 0;
  if (!hasUpload && pasted.length < MIN_USABLE_CHARS) {
    return bad("This lesson is too short to work with. Add more of the lesson text.");
  }

  /**
   * Stamp the term and session, ONCE, here.
   *
   * Copied byte for byte from the school's setting and never resolved again: the
   * current term moves, but a lesson taught in first term must still report
   * first term when a student filters their subject shelf in third.
   *
   * UNLIKE AN ASSIGNMENT, AN UNSET TERM IS NOT AN ERROR HERE, and the difference
   * is deliberate. `/api/tutor/assignments` answers 409 and refuses, because an
   * assignment's mark has to land in a specific term's continuous assessment and
   * a mark filed under the wrong term is worse than no mark. A lesson carries no
   * mark. Refusing to create one would break the core loop - the entire MVP -
   * over a setting a school admin has not opened yet, so it stamps null and the
   * lesson shows under "Earlier" until the shelf can place it.
   *
   * Never fall back to a guess from the clock. See the note on Lesson.term.
   */
  const settings = await getCurrentTermSession(session.schoolId);

  /**
   * The id comes first so the file can be stored under the lesson's own key
   * BEFORE the document exists; the document is then written once, already
   * pointing at it. If the write fails the claimed file is removed, so a failure
   * leaves nothing behind either way round.
   */
  const lessonId = newLessonId();
  let claimed: ClaimedFile | null = null;
  if (hasUpload) {
    try {
      claimed = await claimUpload(tutorActor(session), "lesson", uploadKey, fileName, (ext) =>
        lessonFileKey(session.schoolId, lessonId, ext)
      );
    } catch (err) {
      if (err instanceof UploadError) return bad(err.message, err.status);
      throw err;
    }
  }

  /**
   * Pasted text wins when there is enough of it. Otherwise the file's text, read
   * best effort - "" for a scan, a slide deck or a photo, which is still a
   * working lesson whose material is the file itself.
   */
  const enoughPasted = pasted.length >= MIN_USABLE_CHARS;
  const fromFile = claimed && !enoughPasted ? await readClaimedText(claimed) : "";
  const extractedText = enoughPasted ? pasted : fromFile || pasted;

  try {
    await createLesson(
      {
        schoolId: session.schoolId,
        tutorId: session.uid,
        topicId,
        classId,
        className,
        subjectId,
        title,
        extractedText,
        term: settings?.term ?? null,
        session: settings?.session ?? null,
        status: "draft",
        ...(claimed ? fileFields(claimed) : {}),
      },
      lessonId
    );
  } catch (err) {
    await discardClaimed(claimed);
    throw err;
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "lesson.create",
    entityId: lessonId,
  });

  if (publishMaterial) {
    await setMaterialPublished(lessonId, true);
    await writeAuditLog({
      schoolId: session.schoolId,
      actorUid: session.uid,
      action: "lesson.material.publish",
      entityId: lessonId,
    });
    // Students in this class can see it now, so drop their cached list.
    revalidateTag(studentLessonsTag(classId));
  }

  return NextResponse.json({
    lessonId,
    // False sends the tutor to the lesson page, which says what to do next.
    textFound: extractedText.length >= MIN_USABLE_CHARS,
  });
}
