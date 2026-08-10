import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { JD, RP } from "@/lib/db/collections";
import { getTutorSession, assertClassAccess } from "@/lib/auth/tutor";
import { getSubjects } from "@/lib/db/resultpeak";
import { createAssignment, writeNotification } from "@/lib/db/assignments";
import { writeAuditLog } from "@/lib/db/lessons";
import { SUBMITTABLE_TYPES } from "@/lib/storage/file-types";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { isKnownSession, isKnownTerm } from "@/lib/academic-calendar";
import { ASSIGNMENT_TYPES } from "@/types/student-dashboard";
import type { AssignmentType } from "@/types/student-dashboard";
import type { Lesson, ResultPeakClass } from "@/types";

/**
 * Create an assignment.
 *
 * Authorization is server-side and unconditional: the class must be in the
 * tutor's assignedClasses, read fresh from ResultPeak on this request. The form
 * hiding a class it should not offer is a convenience, not a control.
 */

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;
const MIN_GUIDE = 20;
const MAX_GUIDE = 4000;

interface Body {
  classId?: string;
  subjectId?: string;
  title?: string;
  description?: string;
  type?: string;
  dueDate?: number;
  maxMarks?: number;
  markingGuide?: string;
  linkedLessonId?: string | null;
  allowedFileTypes?: string[] | null;
  term?: string;
  session?: string;
  isActive?: boolean;
}

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const body = (await req.json().catch(() => ({}))) as Body;

  const classId = body.classId?.trim() ?? "";
  const subjectId = body.subjectId?.trim() ?? "";
  const title = body.title?.trim() ?? "";
  const description = body.description?.trim() ?? "";
  const markingGuide = body.markingGuide?.trim() ?? "";

  if (!title) return bad("Give the assignment a title.");
  if (title.length > MAX_TITLE) return bad(`Keep the title under ${MAX_TITLE} characters.`);
  if (description.length > MAX_DESCRIPTION) {
    return bad(`Keep the instructions under ${MAX_DESCRIPTION} characters.`);
  }
  if (!classId) return bad("Choose a class.");
  if (!subjectId) return bad("Choose a subject.");

  try {
    assertClassAccess(session, classId);
  } catch {
    return bad("You don't teach that class.", 403);
  }

  const type = body.type as AssignmentType;
  if (!ASSIGNMENT_TYPES.includes(type)) return bad("Choose an assignment type.");

  const dueDate = Number(body.dueDate);
  if (!Number.isFinite(dueDate)) return bad("Choose a due date.");
  if (dueDate <= Date.now()) return bad("The due date has already passed. Pick a later one.");

  const maxMarks = Number(body.maxMarks);
  if (!Number.isInteger(maxMarks) || maxMarks < 1 || maxMarks > 100) {
    return bad("Marks available must be a whole number between 1 and 100.");
  }

  /**
   * Term and session, validated against the school's setting and stored VERBATIM.
   *
   * No trim, no case fold, no normalisation, here or anywhere. ResultPeak joins a
   * result sheet on these literal strings, so a value we tidied is a value that
   * silently stops joining. Validation is exact membership only.
   *
   * The setting is read once, here, at creation. Nothing downstream ever asks
   * what the current term is again.
   */
  const settings = await getCurrentTermSession(session.schoolId);
  if (!settings) {
    return bad(
      "Your school admin has not set the current term and session yet. Ask them to open Assessment settings.",
      409
    );
  }

  const term = body.term;
  const academicSession = body.session;

  if (typeof term !== "string" || !isKnownTerm(term)) {
    return bad("Choose a term.");
  }
  if (
    typeof academicSession !== "string" ||
    !isKnownSession(academicSession, settings.knownSessions)
  ) {
    return bad("Choose a session your school uses.");
  }

  /**
   * The marking guide is required, not optional. It is the entire basis on which
   * the AI marks, and an empty guide produces a confident number backed by
   * nothing that then counts toward a real child's continuous assessment.
   */
  if (markingGuide.length < MIN_GUIDE) {
    return bad("Write what a correct answer should include. The AI marks against this.");
  }
  if (markingGuide.length > MAX_GUIDE) {
    return bad(`Keep the marking guide under ${MAX_GUIDE} characters.`);
  }

  /**
   * Absent is NOT the same as empty, and the difference is a real one for a
   * child: an empty array is a tutor who ticked nothing, so typed answers only,
   * while an absent field is a tutor who was never asked, which falls back to
   * DEFAULT_ALLOWED_FILE_TYPES at read time. Storing [] for both would refuse a
   * photo of an exercise book that nobody decided to refuse.
   *
   * Whatever is sent is still filtered against SUBMITTABLE_TYPES, so a request
   * cannot invent an extension the grading path has no way to read.
   */
  const allowedFileTypes = Array.isArray(body.allowedFileTypes)
    ? body.allowedFileTypes.filter((t): t is string =>
        (SUBMITTABLE_TYPES as readonly string[]).includes(t)
      )
    : null;

  // Class and subject are ResultPeak's. Read them to denormalize the display
  // names, and to prove the class is real rather than trusting the request.
  const [classSnap, subjects] = await Promise.all([
    adminDb.doc(`${RP.classes}/${classId}`).get(),
    getSubjects(session.schoolId),
  ]);

  const cls = classSnap.exists ? (classSnap.data() as ResultPeakClass) : null;
  if (!cls || cls.schoolId !== session.schoolId) return bad("That class no longer exists.", 404);

  const subject = subjects.find((s) => s.id === subjectId);
  if (!subject) return bad("That subject is not on your school's list.");

  // An optional link to a lesson, verified rather than trusted.
  let linkedLessonId: string | null = null;
  if (body.linkedLessonId) {
    const snap = await adminDb.doc(`${JD.lessons}/${body.linkedLessonId}`).get();
    const lesson = snap.exists ? (snap.data() as Lesson) : null;
    if (!lesson || lesson.schoolId !== session.schoolId || lesson.classId !== classId) {
      return bad("That lesson is not in this class.");
    }
    linkedLessonId = body.linkedLessonId;
  }

  const isActive = body.isActive !== false;

  const assignmentId = await createAssignment({
    schoolId: session.schoolId,
    classId,
    className: cls.name,
    subjectId,
    subjectName: subject.name,
    tutorId: session.uid,
    title,
    description,
    type,
    dueDate,
    maxMarks,
    markingGuide,
    linkedLessonId,
    allowedFileTypes,
    term,
    session: academicSession,
    isActive,
  });

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: "assignment.create",
    entityId: assignmentId,
    detail: `${type} for ${cls.name}, ${maxMarks} marks`,
  });

  /**
   * One feed item for the class, not one per student. Only when the assignment
   * is active: a draft the tutor has not switched on yet must not announce
   * itself. Best effort - a failed feed write must not lose the assignment the
   * tutor just spent ten minutes writing.
   */
  if (isActive) {
    try {
      await writeNotification({
        schoolId: session.schoolId,
        audience: "class",
        targetId: classId,
        type: "new_assignment",
        title,
        body: `${subject.name}. Due ${new Date(dueDate).toDateString()}.`,
        entityId: assignmentId,
      });
    } catch {
      // The assignment exists; the feed item is decoration.
    }
  }

  return NextResponse.json({ ok: true, assignmentId });
}

/** Anything other than POST. Keeps a stray GET from looking like a soft failure. */
export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 });
}
