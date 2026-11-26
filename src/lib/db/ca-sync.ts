import "server-only";
import { getColumnSetting } from "./school-settings";
import { averagePercentage, listFinalisedForSubject, recordCaSync } from "./submissions";
import { syncContinuousAssessment } from "./academic-records";
import { writeAuditLog } from "./lessons";
import { caColumnOf, marksForColumn } from "@/lib/assessment/ca";
import type { CaSyncRecord } from "@/lib/assessment/marking";
import type { AssignmentSubmission } from "@/types/student-dashboard";

/**
 * Send one released mark's subject average to the report card, and RECORD what
 * happened on the submission.
 *
 * THE ONE PATH, shared by releasing a mark and by "Send to report card again",
 * so a resend does exactly what the first send did.
 *
 * NEVER THROWS. Before 2026-11-26 the send ran unguarded after the release had
 * already been saved, so a failure there returned an error to the tutor while
 * the child already saw the mark; a retry was then refused as "changed since you
 * marked it", and the report card never got the mark. Nothing recorded the gap.
 * Now every outcome, including a failure, is written to `submission.caSync` and
 * to the audit log, and the tutor's page offers to send it again.
 *
 * The average is RECOMPUTED from every finalised mark in the same column, never
 * incremented, so sending twice converges instead of drifting.
 */
export async function sendMarkToReportCard(
  submission: AssignmentSubmission,
  actorUid: string
): Promise<{ record: CaSyncRecord; average: number | null }> {
  const id = submission.id;
  let average: number | null = null;
  let finalisedCount = 0;

  try {
    // Term AND session, both read off the submission, never resolved now.
    const [finalised, settings] = await Promise.all([
      listFinalisedForSubject(
        submission.schoolId,
        submission.studentId,
        submission.subjectId,
        submission.term,
        submission.session
      ),
      getColumnSetting(submission.schoolId),
    ]);
    /**
     * Only the marks that land in THIS mark's report-card column. Older
     * assignments with no column of their own land in the admin's column, so
     * they share an average with newer assignments that chose that same column.
     */
    const adminColumn = settings.lmsAssessmentType;
    const marks = marksForColumn(
      replaceOrAppend(finalised, submission),
      caColumnOf(submission, adminColumn),
      adminColumn
    );
    finalisedCount = marks.length;
    average = averagePercentage(marks);
  } catch (e) {
    return finish(submission, actorUid, failed(e, "average"), null);
  }

  if (average === null) {
    return finish(
      submission,
      actorUid,
      { status: "skipped", reason: "nothing_released", at: Date.now() },
      null,
      "no finalised marks yet"
    );
  }

  try {
    /**
     * NO DEFAULT AND NO FALLBACK on the column, decided inside the sync. If the
     * school has not chosen one, or it was removed or relabelled in ResultPeak,
     * the sync is SKIPPED and says why. It is never redirected elsewhere.
     */
    const outcome = await syncContinuousAssessment({
      schoolId: submission.schoolId,
      studentId: submission.studentId,
      subjectId: submission.subjectId,
      session: submission.session,
      term: submission.term,
      assessmentTypeId: submission.assessmentTypeId,
      percentage: average,
      submissionCount: finalisedCount,
    });
    const record: CaSyncRecord =
      outcome.status === "written"
        ? {
            status: "written",
            assessmentTypeId: outcome.assessmentTypeId,
            percentage: outcome.percentage,
            at: Date.now(),
          }
        : { status: "skipped", reason: outcome.reason, at: Date.now() };
    return finish(
      submission,
      actorUid,
      record,
      average,
      outcome.status === "skipped" ? outcome.detail : undefined
    );
  } catch (e) {
    return finish(submission, actorUid, failed(e, "send"), average);
  }

  function failed(e: unknown, step: string): CaSyncRecord {
    console.error(`[ca-sync] ${id} step=${step}:`, e instanceof Error ? e.message : e);
    return { status: "failed", at: Date.now() };
  }
}

/** Write the record and the audit line. Each is best effort; neither may throw. */
async function finish(
  submission: AssignmentSubmission,
  actorUid: string,
  record: CaSyncRecord,
  average: number | null,
  detail?: string
): Promise<{ record: CaSyncRecord; average: number | null }> {
  await recordCaSync(submission.id, record).catch((e) =>
    console.error(`[ca-sync] ${submission.id} step=record:`, e instanceof Error ? e.message : e)
  );

  // Never silent. The tutor page reads these to explain itself.
  if (record.status !== "written") {
    await writeAuditLog({
      schoolId: submission.schoolId,
      actorUid,
      action: record.status === "failed" ? "assignment.ca.failed" : "assignment.ca.skipped",
      entityId: submission.id,
      detail:
        record.status === "failed"
          ? `subject=${submission.subjectId} term=${submission.term} session=${submission.session}`
          : `reason=${record.reason} ${detail ?? ""}`.trim(),
    }).catch((e) =>
      console.error(`[ca-sync] ${submission.id} step=audit:`, e instanceof Error ? e.message : e)
    );
  }

  return { record, average };
}

/** The just-released submission may or may not be in the query's results yet. */
function replaceOrAppend(
  rows: AssignmentSubmission[],
  updated: AssignmentSubmission
): AssignmentSubmission[] {
  return [...rows.filter((r) => r.id !== updated.id), updated];
}
