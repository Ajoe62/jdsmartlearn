# Prompt to run in the ResultPeak repo: label report-card columns for JDSmartLearn

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It asks ResultPeak to label each report-card column
(each entry of `schools/{id}.assessmentTypes`) so JDSmartLearn can tell a
teacher-marked coursework column from an exam, and to keep JDSmartLearn's marks
and hand-typed marks from being counted twice.

**Ordering: JDSmartLearn is already live and safe in any order.** Since
2026-11-25 it fails closed. Teachers are offered no column until this work
labels one, and assignment marks go to the column the school admin chose in
Assessment settings, which itself refuses anything named like an exam. Nothing
here is a blocker for JDSmartLearn. Task 1 is what turns per-assignment column
choice back on.

After it ships, JDSmartLearn has no code change to make: its column list fills
itself from the labels. Its stopgap name check ("refuse a column called exam")
switches off by itself for each school ResultPeak labels. Delete that stopgap
from `isAdminColumnAllowed()` in `src/lib/assessment/ca.ts` once every school is
labelled.

---

## Context

You are working in **ResultPeak**, a school exam and results platform, live with
paying schools. A sibling product, **JDSmartLearn** (an LMS), runs inside the
*same* Firebase project: same `projectId`, same Auth directory, same Firestore
database. It reads ResultPeak's collections and never writes to them, with one
exception described below.

Teachers set assignments in JDSmartLearn, mark them, and release the marks.
Each released mark has to reach one column of the child's report card, for
example "1st CA". A school's columns are ResultPeak's: the array
`schools/{schoolId}.assessmentTypes`, one entry per column, each with a stable
`value`, a `label` and a `maxScore`.

**When a teacher creates an assignment, they now choose which column its marks
feed.** The school owner decided this on 2026-11-25. Assignments created
earlier, and schools that have no labelled columns yet, feed the one column the
school admin set in JDSmartLearn's Assessment settings
(`jdSchoolSettings/{schoolId}.lmsAssessmentType`). That admin setting is the
original design, not a fallback. JDSmartLearn never picks a column itself.

**The problem this fixes.** Nothing in `assessmentTypes` says which columns a
teacher fills by hand and which are exams or computed by ResultPeak. Until
2026-11-25 JDSmartLearn offered every column, so a teacher could send homework
into the **Exam** column. JDSmartLearn now offers only columns that are
explicitly labelled, so until you add the labels, teachers see no list at all.

### What JDSmartLearn writes, and where

JDSmartLearn writes to one shared document, owned by neither platform:

```
studentAcademicRecords/{schoolId}_{studentId}
  continuousAssessment.{subjectId}.{assessmentTypeValue} = 0..100   (a PERCENTAGE)
  lastUpdatedByLMS = epoch ms
```

It writes those two field roots **and nothing else**, enforced by an allowlist
(`assertRecordFields()` on its side). Values are percentages, never raw marks.
**ResultPeak owns each column's `maxScore` and does the scaling:**
`Math.round(percentage / 100 * maxScore)`. JDSmartLearn never does that sum.
Read `docs/firestore-rules-to-append.md` in the JDSmartLearn repo, section
"BLOCKING: the fold into manualScores must be idempotent", before touching the
fold (the code that copies these values into `manualScores`). Everything in that
section still applies.

## Hard constraints

- **Never write a JDSmartLearn collection** (`assignments`, `submissions`,
  `jdCaScores`, `jdSchoolSettings`, or anything prefixed `jd`).
- **Never `set()` `studentAcademicRecords` without `merge`**, and never write its
  `continuousAssessment` or `lastUpdatedByLMS` roots. That would destroy the
  other platform's marks with no way back.
- **Do not deploy Firestore rules or indexes as part of this work** unless your
  normal process covers it. The rules file is yours, but a mistake there breaks
  live exams.
- **Never move, recalculate or delete a historical score.** Any later migration
  is dry-run first and approved by the school.
- **Term and session strings are copied byte for byte.** Never normalise, trim,
  case-fold or infer one.
- **No auto-marking or AI** in any part of this.

## The invariants

1. **Every entry of every school's `assessmentTypes` carries an explicit boolean
   `teacherMarked`.** Never absent. `true` only for columns a teacher fills by
   hand (CAs, tests, projects, assignments). `false` for exams and for anything
   ResultPeak computes.
2. **A school's labels are written in ONE write.** JDSmartLearn turns strict for
   a school the moment any one of its columns says `teacherMarked: true`. From
   then on, only labelled columns may receive marks, including the admin's
   column. Labelling a school half-way stops marks for the columns left
   unlabelled.
3. **A column's `value` is never reused for a different column.** Renaming the
   `label` is fine. Reusing a `value` silently sends marks meant for the old
   column into the new one, on every report card at once.
4. **A `value` never contains a `.`** It is a field key inside
   `continuousAssessment.{subjectId}`, and JDSmartLearn refuses to write one.
5. **A mark is counted once.** For one student, subject, term, session and
   column, a JDSmartLearn mark and a hand-typed mark are never summed together.

## Task 1 (P0): label every column

The exact shape JDSmartLearn reads, on each element of
`schools/{schoolId}.assessmentTypes`:

```ts
{
  value: string;          // stable id, never reused, no "."
  label: string;          // what admins and teachers see
  maxScore: number;
  teacherMarked: boolean; // REQUIRED. true = a teacher fills it by hand
  automated?: boolean;    // true = ResultPeak computes it (e.g. a CBT exam)
  systemMarked?: boolean; // true = filled by the system, not a teacher
}
```

Use these **exact field names**. JDSmartLearn looks for `teacherMarked`,
`automated` and `systemMarked` and nothing else. A column is offered to teachers
only when `teacherMarked === true` and neither of the other two is `true`.
Another name (`kind: "exam"`, `isExam`, `type`) is not seen at all.

1. In the school's assessment-structure editor, add a required yes/no for each
   column: "Teachers enter this mark by hand". A new column cannot be saved
   without an answer. There is no default.
2. Columns ResultPeak itself computes are `teacherMarked: false,
   automated: true`, set by your code and not editable by the admin.
3. **Backfill existing schools without guessing.** Run a dry-run that lists each
   school's columns. Set `teacherMarked: false` (plus `automated: true`) only on
   columns your code *knows* it computes. For everything else, the school admin
   answers the question in the editor. Do not infer `true` from a name like
   "CA". Write each school's labels in one update (invariant 2).
4. Add checks so a `value` cannot be edited after creation, and a deleted
   column's `value` cannot be reused (invariant 3).

## Task 2 (P0): the fold refuses an exam column too

Where ResultPeak copies `continuousAssessment` values into `manualScores`,
refuse any value whose column is not `teacherMarked: true` (or is `automated`
or `systemMarked`). Log it, don't write it. JDSmartLearn already refuses these
on its side. This is the second lock on the same door.

## Task 3 (P1): never count a mark twice

Applies only once the fold exists. If it does not exist yet, stop after Task 2
and report that.

1. **How ResultPeak knows a column is fed by JDSmartLearn.** Use the fold's own
   deterministic row: a `manualScores` document with id
   `lms__{studentId}__{schoolId}__{classId}__{academicSession}__{term}__{subjectId}__{assessmentType}`
   and `source: "jdsmartlearn"`. If that row exists, the column is JDSmartLearn's
   for that student, subject, term and session. Do not use
   `studentAcademicRecords.lastUpdatedByLMS`. It is one timestamp for the whole
   record, not per column.
2. **Lock hand entry.** In score entry, a cell with an LMS row shows the mark
   read-only, labelled "From JDSmartLearn", and cannot be typed into.
3. **Where both already exist** (a hand-typed row was entered before the LMS row
   arrived): **the hand-typed mark counts, the LMS row is left out of the sum,
   and the cell is flagged** for the class teacher to resolve. This way no number
   already printed on a report card changes. Never delete either row.

## Stop and report: the shared record has no term

`studentAcademicRecords/{schoolId}_{studentId}` is keyed by school and student
only, and `continuousAssessment.{subjectId}.{column}` holds **one number**. It
carries no term and no session. A Second Term release therefore overwrites the
First Term value at the same key. **Do not build or change the fold on the
assumption that this value belongs to "the current term".** Inferring the term
from today's date is the exact silent-join failure both repos forbid. If your
fold already does that, report it. Do not fix it alone: the record's shape is
shared, and JDSmartLearn has to change what it writes in step.

## Definition of done

- [ ] Every school's every column has an explicit `teacherMarked` boolean
- [ ] Each school labelled in a single write; dry-run output kept
- [ ] No `teacherMarked: true` inferred from a column name
- [ ] Editor requires the answer for new columns; `value` immutable, never reused
- [ ] Fold refuses non-teacher-marked columns and logs it (Task 2)
- [ ] Task 3 done, or a written report that the fold does not exist yet
- [ ] Term question answered in writing (above), not assumed
- [ ] No JDSmartLearn collection written; no historical score changed

## Verification

1. In JDSmartLearn, sign in as a teacher at a labelled school and open **New
   assignment**. The "Result-sheet box" list shows exactly the columns marked
   `teacherMarked: true`, and never the exam.
2. Same school, as admin, open **Assessment settings**. The column list shows
   only labelled teacher-marked columns.
3. At a school not yet labelled, the teacher sees the note "Marks from this
   assignment will go to the report-card column your school admin chose…"
   instead of a list. That is the correct state, not a bug.
4. Release one mark in JDSmartLearn and confirm it lands, scaled by `maxScore`,
   in the right column and only once.
