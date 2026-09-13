# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It asks ResultPeak to keep `assignedClasses` equal to
the classes in `assignments`, as its own contract says, and to get the two tutor
profiles in production where it is not reviewed by the school.

**Nothing here blocks JDSmartLearn.** Its side shipped first and is safe on its
own: a class a tutor holds with no subject now lists every subject (enforcement
off) or shows a message naming the fix (enforcement on), instead of an empty
box. That is a workaround for the data. This prompt is the fix.

Recorded as defect 6 in JDSmartLearn's `docs/resultpeak-defects.md`.

---

## Context

JDSmartLearn is a lesson product for the same schools, running in **this**
Firebase project: same Auth directory, same Firestore database. It reads
ResultPeak's collections and never writes them, and deploys from its own
repository.

It reads each tutor's allocation from `schools/{schoolId}/tutors/{uid}`:

```js
assignments: [{ classId, subjectId }, ...],   // the authored truth
subjectClasses: { [subjectId]: [classId] },   // derived
assignedSubjects: [subjectId],                // derived
classTeacherOf: [classId],                    // capped at one
assignedClasses: [classId],                   // derived union of assignments' classes
```

It scopes every tutor request by `assignedClasses` first, then narrows its
subject pickers to `subjectClasses`. When a school sets
`schools/{id}.subjectAllocation: true`, it also refuses any (class, subject)
pair that is not in `subjectClasses`.

### What is wrong in production, verified 2026-09-13

At Mt Cedar British International School (`dV6zL3AEydAFJc3D3GrO`), two tutors
hold a class in `assignedClasses` that no entry in `assignments` names.
`subjectClasses` matches `assignments` in both; only `assignedClasses` is off.

| Tutor uid | Extra class in `assignedClasses` | `classTeacherOf` | `assignmentsUpdatedAt` |
|---|---|---|---|
| `3BV6nNf9rvVpA2olgI8D0farRjq1` | `wlCep9iEmYL9aZ96slVm` (Nursery 1) | `[]` | 2026-09-12T19:02:31Z |
| `meKwqrDX9eUt8qltyNkaC8ZszVc2` | `ohWRsEorAi5GY0Fm7NZR` (SSS 1) | `[]` | 2026-09-10T10:46:29Z |

The first surfaced as a teacher unable to pick a subject for Nursery 1 in
JDSmartLearn. No other school in the project has the problem.

Suspected cause, not confirmed: the allocation save **merges** the classes in the
new `assignments` into the stored `assignedClasses` instead of **recomputing**
it, so removing a class's last subject pair leaves the class behind. A separate
screen that edits `assignedClasses` on its own would produce the same data.

## Hard constraints

- **Do not change the shape of any of the five fields.** JDSmartLearn reads them
  directly.
- **`assignedClasses` means the union of the classes in `assignments`.** If
  ResultPeak has since decided it should mean something wider (for example, also
  the class in `classTeacherOf`), stop and say so in your reply rather than
  fixing towards the old meaning. JDSmartLearn would then need to change what a
  class with no subject means, and that is a decision for both sides.
- **Do not silently drop classes from live profiles.** Removing a class from
  `assignedClasses` removes that tutor's access to the lessons, assignments and
  marks they already have there, in both products. Repair is a school admin's
  decision, per tutor (Task 3).
- **Never write to JDSmartLearn's collections** (`lessons`, `assignments`,
  `schemes`, `topics`, anything prefixed `jd`). Nothing here needs them.
- Do not deploy Firestore rules or indexes as part of this.

## The invariant

For every tutor profile, after every write that touches any of the five fields:

```
set(assignedClasses) == set(assignments[].classId)
subjectClasses[s]    == [c for { classId: c, subjectId: s } in assignments]
assignedSubjects     == keys(subjectClasses)
```

If `classTeacherOf` is meant to be included, extend the first line and say so,
per the constraint above. All five fields are written in **one** atomic write.

## Task 1 (P0) — Find every writer of `assignedClasses`

List every code path that writes `assignedClasses` on a tutor profile: the
allocation endpoint, invite or onboarding, any class-assignment screen, any
migration or backfill script, any Cloud Function. For each, say whether it
recomputes from `assignments` or merges into the stored value. Give the file and
line in your reply.

## Task 2 (P0) — Derive it, in one place

Make every writer compute `assignedClasses` from `assignments` with one shared
function, in the same atomic write as `subjectClasses` and `assignedSubjects`.
A writer that has no `assignments` to hand (a legacy class-only screen) must
either write `assignments` too or be removed; it must not edit `assignedClasses`
on its own.

Add a test for the case that broke: a tutor with pairs in classes A and B has
every pair in B removed, and `assignedClasses` becomes `[A]`.

## Task 3 (P1) — Show the drift to the school, and let the admin repair it

Write a read-only report (a script is fine) that lists every tutor where the
invariant fails, per school, with class names. Today it should print the two
rows above.

Repair is then the school admin's choice for each row, made in the normal
allocation screen:

- **allocate the tutor's subjects for that class**, if they still teach there, or
- **remove the class** from the tutor, if they no longer do.

Once Task 2 ships, either is one ordinary save, and that save repairs the
profile. Do not write a bulk script that drops the classes.

## Task 4 (P2) — Guard against it coming back

Wherever tutor profiles are validated or audited on your side, add the invariant
as a check, so a new writer that merges instead of deriving fails a test rather
than a teacher.

## What JDSmartLearn does after this ships

Nothing in code. Its workaround stays, because it is also correct for a subject a
school removes from its list after allocating it. Once the two profiles are
repaired, `npm run diagnose:allocations` in the JDSmartLearn repo reports no
problems for Mt Cedar, and the "Every subject is listed for this class" note
stops appearing for those two tutors.

Tell JDSmartLearn if Task 1 finds `assignedClasses` was deliberately widened
beyond `assignments`; that changes its side.

## Definition of done

- [ ] Every writer of `assignedClasses` listed, with file and line
- [ ] One shared derive function; all five fields written atomically
- [ ] Test: removing a class's last pair removes the class
- [ ] Read-only drift report, showing the two Mt Cedar rows before repair
- [ ] Mt Cedar's admin told which two tutors to review, and why
- [ ] No bulk script drops classes from live profiles

## Verification

Run the drift report after the admin's review: nothing for Mt Cedar. In
JDSmartLearn, `npm run diagnose:allocations -- dV6zL3AEydAFJc3D3GrO` reports no
problems.
