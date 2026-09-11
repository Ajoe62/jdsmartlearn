import { NextResponse } from "next/server";
import {
  getTutorSession,
  assertClassAccess,
  assertSubjectAccess,
} from "@/lib/auth/tutor";
import { MAX_STORED_CHARS } from "@/lib/extract/text";
import { createScheme, newSchemeId } from "@/lib/db/schemes";
import { writeAuditLog } from "@/lib/db/lessons";
import { getClassesByIds, getSubjects, listClassesForSchool } from "@/lib/db/resultpeak";
import { getCurrentTermSession } from "@/lib/db/school-settings";
import { schemeFileKey } from "@/lib/storage/keys";
import {
  UploadError,
  claimUpload,
  discardClaimed,
  fileFields,
  readClaimedText,
  tutorActor,
  type ClaimedFile,
} from "@/lib/storage/uploads";
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
 *
 * THE FILE ARRIVES AS A STAGING KEY, not bytes - the browser has already put it
 * in R2, because a Vercel function refuses bodies over 4.5 MB. It is claimed
 * BEFORE the scheme is created, so a failed store is an error the tutor sees,
 * never a scheme quietly saved without its document (which is what used to
 * happen: the store failure was swallowed and the tutor told it had worked).
 *
 * TEXT IS A BONUS HERE, never a condition. A scanned scheme, an old .doc or a
 * spreadsheet is kept as the original that students open; text is shown beside
 * it when it can be read.
 */

const MAX_TITLE = 120;
/** A Nigerian term runs 12 to 14 weeks; 20 is slack, not a target. */
const MAX_WEEKS = 20;
const MAX_WEEK_TOPIC = 200;

interface Body {
  classId?: string;
  subjectId?: string;
  title?: string;
  text?: string;
  weeks?: unknown;
  publish?: boolean;
  uploadKey?: string;
  fileName?: string;
}

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

  // A page from before direct uploads posts multipart, which is not JSON.
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return bad("This page is out of date. Reload it, then try again.");

  const classId = String(body.classId ?? "").trim();
  const subjectId = String(body.subjectId ?? "").trim();
  const title = String(body.title ?? "").trim();
  const pasted = String(body.text ?? "").trim();
  const publish = body.publish === true;
  const hasUpload = typeof body.uploadKey === "string" && body.uploadKey.length > 0;

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

  const weeks = parseWeeks(body.weeks);
  if (!Array.isArray(weeks)) return bad(weeks.error);

  if (pasted.length > MAX_STORED_CHARS) {
    return bad("That text is too long to paste. Upload it as a file instead.");
  }

  /**
   * A scheme needs SOMETHING - a document, typed text, or a week list.
   *
   * No minimum length, unlike a lesson. A lesson under 200 characters cannot be
   * summarised usefully; a scheme is not summarised at all, and "Weeks 1-3:
   * revision" is a legitimate scheme of work for a short term.
   */
  if (!hasUpload && !pasted && weeks.length === 0) {
    return bad("Add the scheme of work: upload a document, paste it, or fill in the weeks.");
  }

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

  const schemeId = newSchemeId();
  let claimed: ClaimedFile | null = null;
  if (hasUpload) {
    try {
      claimed = await claimUpload(tutorActor(session), "scheme", body.uploadKey, body.fileName, (ext) =>
        schemeFileKey(session.schoolId, schemeId, ext)
      );
    } catch (err) {
      if (err instanceof UploadError) return bad(err.message, err.status);
      throw err;
    }
  }

  const extractedText = pasted || (claimed ? await readClaimedText(claimed) : "");

  /**
   * Term and session, stamped once and copied byte for byte - the same rule as a
   * lesson. Null when the school admin has not set the current term yet; the
   * scheme then shows under "Earlier" rather than being guessed into a term.
   */
  const settings = await getCurrentTermSession(session.schoolId);

  try {
    await createScheme(
      {
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
        ...(claimed ? fileFields(claimed) : {}),
      },
      schemeId
    );
  } catch (err) {
    await discardClaimed(claimed);
    throw err;
  }

  await writeAuditLog({
    schoolId: session.schoolId,
    actorUid: session.uid,
    action: publish ? "scheme_published" : "scheme_created",
    entityId: schemeId,
  }).catch(() => {});

  return NextResponse.json({ id: schemeId, textFound: extractedText.length > 0 }, { status: 201 });
}
