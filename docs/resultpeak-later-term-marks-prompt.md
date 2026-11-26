# Prompt to run in the ResultPeak repo: marks for next term, released this term

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It asks ResultPeak to prove where a mark lands when a
teacher releases it during the holiday, for work that counts towards the NEXT
term, while the school is still in the current one.

**Ordering. JDSmartLearn needs no change and is safe to keep running.** It
already stamps every mark with the term of the work it belongs to, never with
"now". But the condition is live today, not hypothetical: Mt Cedar has 26
Second Term holiday assignments open to students right now, due 9 to 14 January
2027, while its School profile says First Term 2026/2027. The first of those
marks could be released any day of the holiday. **Answer the question in step 1
before Mt Cedar prints its First Term report cards.** If the answer is "it lands
on First Term", that is a blocker: tell the owner the same day.

---

## Context

You are working in **ResultPeak**, live with paying schools. **JDSmartLearn**
(an LMS) runs in the same Firebase project and reads ResultPeak's collections
without writing them, with one shared document described below.

Teachers set assignments in JDSmartLearn, mark them and release the marks. Each
assignment is stamped, at creation, with the term and session it counts towards,
copied byte for byte from `schools/{id}.currentTerm` / `.currentSession` or a
LATER term in the same session. A later term is deliberate: holiday work for next
term is set before the holiday starts.

When a teacher releases a mark, JDSmartLearn writes:

```
jdCaScores/{encodeURIComponent(schoolId_studentId_subjectId_session_term_column)}
  schoolId, studentId, subjectId
  session    "2026/2027"        (the ASSIGNMENT's session, verbatim)
  term       "Second Term"      (the ASSIGNMENT's term, verbatim, NOT the current one)
  assessmentTypeId              (the report-card column, an assessmentTypes[].value)
  percentage 0..100             (average of the finalised marks in that column)
  submissionCount, updatedAt
```

and, for the preview only, `studentAcademicRecords/{schoolId}_{studentId}`
`.continuousAssessment.{subjectId}.{column}`, which has **no term at all** (see
"Stop and report" in `docs/resultpeak-scheduled-assignment-boxes-prompt.md` in
the JDSmartLearn repo). JDSmartLearn understands your fold reads `jdCaScores` by
its fields, newest `updatedAt` winning, and that the preview was switched to
`jdCaScores` too. Confirm both.

The live case: **Mt Cedar British International School**,
`schoolId dV6zL3AEydAFJc3D3GrO`. School profile: `currentTerm "First Term"`,
`currentSession "2026/2027"`. JDSmartLearn holds 63 assignments stamped
`"Second Term"` / `"2026/2027"`, 26 of them open to students now. Their columns
are `holiday_assignment` and `project`, both `teacherMarked: true`. No marks have
been released yet.

Your late-marks fix is built behind `LMS_FILE_BY_MARK_TERM` and is currently
**off**.

## Hard constraints

- Never write a JDSmartLearn collection (`jdCaScores`, `jdSchoolSettings`,
  `assignments`, `submissions`, anything prefixed `jd`).
- Never `set()` `studentAcademicRecords` without `merge`, and never write its
  `continuousAssessment` or `lastUpdatedByLMS` roots.
- Never normalise, trim, case-fold or infer a term or session string, and never
  work a term out from the date.
- Never move, recalculate or delete a historical score. Any migration is a
  dry run first, approved by the school.
- Do not deploy Firestore rules or indexes unless your normal process covers it.

## The invariants

1. **A mark is filed under the term written on its `jdCaScores` row, and no
   other.** A `"Second Term"` row never appears on, or changes, a First Term
   result sheet, report card, preview, class position or annual average.
2. **Holding is not losing.** A row for a term the school has not reached yet is
   held, and appears on that term's sheet once the school gets there, exactly
   once, without anyone re-sending it.
3. **This holds with `LMS_FILE_BY_MARK_TERM` off.** It is the state you are in
   now, through the First Term report-card run.

## The work

1. **Answer in writing, with the code paths: with the switch OFF today, where
   does a `"Second Term"` `jdCaScores` row land?** Trace every reader of
   `jdCaScores`: the fold into `manualScores`, the preview, the result sheet,
   the report card, position and the annual average. For each, say whether it
   filters by the row's own `term` and `session` or by the school's current
   term. Any reader that filters by the current term, or not at all, breaks
   invariant 1. Report it to the owner immediately, before fixing.
2. **Prove it with a test, switch off and switch on.** Fixture: school in First
   Term 2026/2027, one `jdCaScores` row for Second Term 2026/2027 and one for
   First Term 2026/2027, same student, subject and column. Assert:
   - the First Term sheet shows only the First Term percentage;
   - the Second Term sheet is empty while the school is in First Term, or shows
     the row as held, whichever your design says, but never on First Term;
   - after the school's `currentTerm` becomes `"Second Term"`, the Second Term
     sheet shows it once, and the First Term sheet is unchanged.
3. **If any reader fails step 1, fix that reader** to filter by the row's own
   `term` and `session`, byte for byte. Do not fix it by copying rows, by
   re-stamping JDSmartLearn's rows, or by reading `studentAcademicRecords`.
4. **Check the preview separately.** It used to read the term-less shared
   record. Confirm it now reads `jdCaScores` and filters by term, or a Second
   Term holiday mark will show in a First Term preview.

## What JDSmartLearn does after this ships

Nothing, if step 1 comes back clean. If a reader is fixed in step 3, tell the
JDSmartLearn owner which, so the test in `docs/resultpeak-term-source-prompt.md`
step 3 can be marked done in both repos.

## Definition of done

- [ ] Written answer for every `jdCaScores` reader: filters by the row's term, or not
- [ ] Test covering switch off and switch on, both terms, before and after the term moves
- [ ] Any reader that broke invariant 1 fixed and reported to the owner
- [ ] Preview confirmed to read `jdCaScores` with a term filter
- [ ] No JDSmartLearn collection written; no historical score changed
