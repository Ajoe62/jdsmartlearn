# Resultpeak handoff: scheduled JDSmartLearn assessment boxes

## Context

JDSmartLearn now creates assignments with a stable `assessmentTypeId` selected
from `schools/{schoolId}.assessmentTypes`. It continues to write only its own
`jdCaScores` and the permitted `studentAcademicRecords.continuousAssessment`
field; it does not write Resultpeak `manualScores`.

## Required Resultpeak work

1. Ensure every assessment type exposes a stable `value`, a display label,
   optional `maxScore`, and an explicit teacher-marked/automated distinction.
   Automated or system examination columns must not be offered to JDSmartLearn.
2. In Resultpeak score-entry UI, prevent a teacher from entering a manual score
   into a box currently supplied by JDSmartLearn for that student/subject/term/
   session. Keep existing historical manual scores unchanged.
3. Preserve literal session and term strings; do not normalise or infer them.
4. Do not migrate, recalculate, move, or delete historical scores as part of
   this work. Any future migration must be dry-run and school-approved.

## JDSmartLearn behaviour

New assignments use their own `assessmentTypeId`; legacy assignments without
one retain the existing school-level fallback. Scheduled visibility is enforced
only by JDSmartLearn and has no Resultpeak background-job dependency.

## Ordering

JDSmartLearn can ship first without writing Resultpeak manual-score documents.
The explicit assessment-type flags and manual-entry guard should land before a
school relies on the new per-assignment boxes operationally.
