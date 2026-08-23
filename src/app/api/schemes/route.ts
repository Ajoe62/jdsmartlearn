import { extname } from "node:path";
import { NextResponse } from "next/server";
import {
  getTutorSession,
  assertClassAccess,
  assertSubjectAccess,
} from "@/lib/auth/tutor";
import { extractText, ExtractionError } from "@/lib/extract/text";
import { createScheme, setSchemeFile } from "@/lib/db/schemes";
import { writeAuditLog } from "@/lib/db/lessons";
import { getClassesByIds, getSubjects, listClassesForSchool } from "@/lib/db/resultpeak";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { putFile, storageConfigured, STORABLE_TYPES } from "@/lib/storage/provider";
import type { SchemeWeek } from "@/types/schemes";

export const maxDuration = 60;

/**
 * Upload a scheme of work for one (class, subject).
 *
 * NOTHING HERE CALLS THE AI PROVIDER, and nothing should. A scheme is the
 * school's own curriculum document; summarising it would invent curriculum, and
 * it must not spend the daily generation cap (CLAUDE.md, Scheme of work rules).
 * There is no generation step, no review gate, and one publish switch.
 *
 * Authorization is server-side and unconditional: the (class, subject) pair must
 * be one this tutor teaches, read fresh from ResultPeak on this request.
 */

const MAX_TITLE = 120;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A Nigerian term runs 12 to 14 weeks; 20 is slack, not a target. */
const MAX_WEEKS = 20;
const MAX_WEEK_TOPIC = 200;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Parse the optional week-by-week outline.
 *
 * Rejects rather than repairs. A silently dropped week is a week of curriculum a
 * class never sees, and the tutor who typed it has no way to notice.
 */
function parseWeeks(raw: unknown): SchemeWeek[] | { error: string } {
  if (raw == null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { error: "We couldn't read the week list." };
  }
  if (!Array.isArray(parsed)) return { error: "We couldn't read the week list." };
  if (parsed.length > MAX_WEEKS) {
    return { error: `A scheme of work can have at most ${MAX_WEEKS} weeks.` };
  }

  const weeks: SchemeWeek[] = [];
  for (const row of parsed) {
    const week = Number((row as { week?: unknown })?.week);
    const topic = String((row as { topic?: unknown })?.topic ?? "").trim();
    if (!topic) continue; // A blank row is a row the tutor left empty, not an error.
    if (!Number.isInteger(week) || week < 1 || week > MAX_WEEKS) {
      return { error: `Week numbers must be whole numbers between 1 and ${MAX_WEEKS}.` };
    }
    if (topic.length > MAX_WEEK_TOPIC) {
      return { error: `Keep each week's topic under ${MAX_WEEK_TOPIC} characters.` };
    }
    weeks.push({ week, topic });
  }
  return weeks.sort((a, b) => a.week - b.week);
}

export async function POST(req: Request) {
  const session = await getTutorSession();
  if (!session) return bad("Sign in to continue.", 401);

  const form = await req.formData();
  const classId = String(form.get("classId") ?? "").trim();
  const subjectId = String(form.get("subjectId") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  const pasted = String(form.get("text") ?? "").trim();
  const file = form.get("file");
  const publish = String(form.get("publish") ?? "") === "true";

  if (!title) return bad("Give the scheme of work a title.");
  if (title.length > MAX_TITLE) return bad(`Keep the title under ${MAX_TITLE} characters.`);
  if (!classId) return bad("Choose a class.");
  if (!subjectId) return bad("Choose a subject.");

  try {
    assertClassAccess(session, classId);
    assertSubjectAccess(session, classId, subjectId);
  } catch {
    return bad("You don't teach that subject to that class.", 403);
  }

  const weeks = parseWeeks(form.get("weeks"));
  if (!Array.isArray(weeks)) return bad(weeks.error);

  // Validate the subject against the school's own list, and pick up the display
  // name to denormalize. An id that is not in `subjects[]` would join to nothing.
  const subjects = await getSubjects(session.schoolId);
  const subject = subjects.find((s) => s.id === subjectId);
  if (!subject) return bad("That subject is not set up for your school.");

  const classes = session.isAdmin
    ? await listClassesForSchool(session.schoolId)
    : await getClassesByIds(session.assignedClasses);
  const klass = classes.find((c) => c.id === classId);
  if (!klass) return bad("That class is not in your school.");

  let extractedText = pasted;
  try {
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return bad("That file is over 10 MB.");
      extractedText = await extractText(file);
    }
  } catch (err) {
    const message =
      err instanceof ExtractionError ? err.message : "We couldn't read that file.";
    return bad(message);
  }

  /**
   * A scheme needs SOMETHING readable - a document, typed text, or a week list.
   *
   * No minimum length, unlike a lesson. A lesson under 200 characters cannot be
   * summarised usefully; a scheme is not summarised at all, and "Weeks 1-3:
   * revision" is a legitimate scheme of work for a short term.
   */
  if (!extractedText && weeks.length === 0) {
    return bad("Add the scheme of work: upload a document, paste it, or fill in the weeks.");
  }

  /**
   * Term and session, stamped once and copied byte for byte - the same rule as a
   * lesson. Null when the school admin has not set the current term yet; the
   * scheme then shows under "Earlier" rather than being guessed into a term.
   */
  const settings = await getCurrentTermSession(session.schoolId);

  const schemeId = await createScheme({
    schoolId: session.schoolId,
    classId,
    className: klass.name,
    subjectId,
    subjectName: subject.name,
    tutorId: session.uid,
    term: settings?.term ?? null,
    session: settings?.session ?? null,
    title,
    extractedText,
    weeks,
    publishedAt: publish ? Date.now() : null,
  });

  // Keep the original document. Text is the student-facing default on a slow
  // link - if storage is not configured or the upload fails, the scheme still
  // works text-only, exactly as a lesson does.
  if (file instanceof File && file.size > 0 && storageConfigured()) {
    const ext = extname(file.name.toLowerCase());
    const storable = STORABLE_TYPES[ext];
    if (storable) {
      try {
        const key = `schemes/${session.schoolId}/${schemeId}${ext}`;
        await putFile(key, Buffer.from(await file.arrayBuffer()), storable.mime);
        await setSchemeFile(schemeId, {
          fileKey: key,
          fileName: file.name,
          fileSize: file.size,
          fileType: storable.mime,
        });
      } catch {
        // Text-only is a working scheme of work. Never fail the upload on it.
      }
    }
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: publish ? "scheme_published" : "scheme_created",
    entityId: schemeId,
  }).catch(() => {});

  return NextResponse.json({ id: schemeId }, { status: 201 });
}
