import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getStudentSession } from "@/lib/auth/student";
import { getAssignment, toStudentAssignment } from "@/lib/db/assignments";
import {
  buildAssignmentList,
  listSubmissionsForStudent,
  toStudentSubmissionPayload,
} from "@/lib/db/submissions";

/**
 * Everything this student's phone needs to show their work offline.
 *
 * One cached class query plus one query for their own submissions, the same two
 * the page uses. Thirty students syncing at 8am share the class query.
 *
 * ETag'd, so the common case - nothing set and nothing marked since yesterday -
 * is a 304 with no body on a 3G link.
 *
 * NEVER carries a marking guide. Assignments go through toStudentAssignment()
 * and submissions through toStudentSubmissionPayload(), both of which name their
 * fields rather than spreading the source document.
 */
export async function GET(req: Request) {
  const session = await getStudentSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const [list, submissions] = await Promise.all([
    buildAssignmentList(session.schoolId, session.classId, session.studentId),
    listSubmissionsForStudent(session.schoolId, session.studentId),
  ]);

  /**
   * Instructions and accepted file types come from the assignment document, which
   * the cached list projection does not carry. Fetched only for assignments the
   * student has not answered yet, and capped: a phone needs to be able to WRITE
   * offline, and there is nothing to write for work already sent.
   */
  const pending = list.filter((item) => item.status === null).slice(0, 20);
  const details = await Promise.all(pending.map((item) => getAssignment(item.assignmentId)));
  const detailById = new Map(
    details
      .filter((a) => a !== null)
      .map((a) => {
        const safe = toStudentAssignment(a);
        return [safe.assignmentId, safe];
      })
  );

  const body = {
    studentId: session.studentId,
    classId: session.classId,
    assignments: list.map((item) => {
      const detail = detailById.get(item.assignmentId);
      return {
        assignmentId: item.assignmentId,
        title: item.title,
        subjectId: item.subjectId,
        subjectName: item.subjectName,
        type: item.type,
        dueDate: item.dueDate,
        maxMarks: item.maxMarks,
        description: detail?.description ?? null,
        allowedFileTypes: detail?.allowedFileTypes ?? [],
      };
    }),
    submissions: submissions.map((s) => {
      const safe = toStudentSubmissionPayload(s);
      return {
        assignmentId: safe.assignmentId,
        status: safe.status,
        submittedAt: safe.submittedAt,
        content: safe.content,
        maxMarks: safe.maxMarks,
        finalScore: safe.finalScore,
        feedback: safe.feedback,
        strengths: safe.strengths,
        improvements: safe.improvements,
        topicsToRevise: safe.topicsToRevise,
        topicsMastered: safe.topicsMastered,
        teacherComment: safe.teacherComment,
      };
    }),
  };

  const json = JSON.stringify(body);
  const etag = `"${createHash("sha1").update(json).digest("base64url")}"`;

  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": "private, no-cache" },
    });
  }

  return new NextResponse(json, {
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      // One student's work on a possibly shared phone. Never a shared cache.
      "Cache-Control": "private, no-cache",
    },
  });
}
