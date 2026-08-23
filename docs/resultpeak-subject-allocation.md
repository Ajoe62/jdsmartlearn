# ResultPeak: subject-level tutor allocation

Written by the ResultPeak side on 2026-08-23, for whoever builds the
JDSmartLearn half. Everything described under "already live" is deployed to the
shared `resultpilot-ddf7c` project today.

Plan this first, do not start editing. Read the files, say what you would change
and in what order, and flag anything here that does not match what the code
actually does.

## The change in one line

A tutor used to be scoped by class alone. They are now scoped by (class,
subject) PAIRS.

## What is already live upstream

`schools/{schoolId}/tutors/{uid}` gained four fields. Nothing existing changed
shape, and `assignedClasses` keeps its exact previous meaning, so this repo
works untouched today and the two sides deploy independently, in either order.

```js
assignments: [                                  // the authored truth
  { classId: "jss1a", subjectId: "mathematics" },
  { classId: "jss2a", subjectId: "mathematics" },
  { classId: "ss1a",  subjectId: "further_mathematics" },
],
subjectClasses: {                               // derived: subjectId -> classIds
  mathematics: ["jss1a", "jss2a"],
  further_mathematics: ["ss1a"],
},
assignedSubjects: ["mathematics", "further_mathematics"],  // derived
classTeacherOf: ["jss1a"],                      // capped at ONE entry
assignedClasses: ["jss1a", "jss2a", "ss1a"],    // UNCHANGED derived union
```

`subjectId` is the same slug this repo already uses on `topics`, `lessons` and
`assignments`: the slugified id from `schools/{id}.subjects[]`. The three
derived fields exist only because Firestore rules cannot compute a cross
product; a rule gets one map lookup, so `subjectClasses[subjectId]` has to be
sitting on the document already.

Only ResultPeak writes these five fields, through one server endpoint, so that
they cannot drift apart. Treat them as read-only here.

## The part that is easy to get backwards

There are TWO switches, and they answer different questions.

**`schools/{schoolId}.subjectAllocation`** is the per-school enforcement flag,
and ABSENT MEANS OFF. This decides whether subject checks apply at all.

**The tutor's own `assignments`** decides how much to narrow the pickers.

| School flag | Tutor `assignments` | What it means |
| --- | --- | --- |
| off | empty | Today's behaviour. No subject checks. Offer every subject. |
| off | populated | Narrow the pickers as a convenience, but do not REFUSE anything. |
| on | populated | Enforce. Only their pairs. |
| on | empty | Refuse everything. Not "allow everything". |

That last row is the point of the flag, and it is the trap. While the flag is
off an unallocated tutor is unrestricted; the moment a school turns it on, an
unallocated tutor can author nothing. Without the flag there is no way to tell
"this school predates the feature" from "this tutor was invited on Friday and
nobody has allocated them yet", and the second would silently hold the entire
school.

So: read the school flag before refusing anything. Never infer enforcement from
`assignments` being empty.

## Current production state, to test against

All schools have `subjectAllocation` absent, so nothing is enforced yet.
Three tutors are backfilled with their full pre-existing access spelled out as
pairs: two in CAPSTONE ACADEMY (`U9SJpzzKUtF6S9V8cG7D`), one in Mt. Cedar
(`dV6zL3AEydAFJc3D3GrO`). No class teachers are named anywhere yet.

> **Corrected 2026-08-23, from the JDSmartLearn side.** This section said "all
> six schools". There are **four**, verified with an aggregate `count()` and a
> listing: HIGHER GROUND (`0KDdRSgNpRnIIdXqjimM`), CAPSTONE ACADEMY, Mt. Cedar,
> Dlink Academy (`eELTSbnIkH3knc7n5qqc`), all `isActive: true`. Everything else
> in this section checked out exactly, including all three backfilled tutors and
> the empty `classTeacherOf` everywhere.
>
> One thing worth knowing that this section does not say: each backfilled tutor
> holds **every subject in their school**, across every class they hold — 36
> pairs for the Mt. Cedar tutor, 42 for each CAPSTONE one. The backfill spelled
> out full pre-existing access literally. So narrowing a picker changes nothing
> visible until somebody edits an allocation down, and "the subject list is
> still 36 long" is the data, not a bug in either product.

## What to change in this repo

1. `src/types/index.ts`: `ResultPeakTutor` gains `assignments?`,
   `subjectClasses?`, `assignedSubjects?`, `classTeacherOf?`. All optional.
   `ResultPeakSchool` gains `subjectAllocation?: boolean`.

2. `src/lib/auth/tutor.ts`: `TutorSession` gains `assignedSubjects`,
   `subjectClasses`, `classTeacherOf`, and a boolean for the school flag. The
   profile fetch in `getTutorSession()` already reads the tutor document, so
   those come free. The school flag is one additional read; check whether
   `getSchool()` in `src/lib/db/resultpeak.ts` is cached before adding a read to
   every authenticated request.

3. `src/lib/auth/tutor.ts`: add `assertSubjectAccess(session, classId, subjectId)`
   beside `assertClassAccess`. Order matters: call `assertClassAccess` first,
   return early for admins, return early when the school flag is off, THEN
   require `subjectClasses[subjectId]` to include `classId`. Same FORBIDDEN
   throw shape as the existing helper.

4. Call it in every route that accepts a subject from the client:
   - `src/app/api/tutor/assignments/route.ts`
   - `src/app/api/lessons/[id]/file/route.ts`
   - any other route touching `lessons`, `topics` or `assignments`. Find them;
     do not trust this list.

5. Filter the subject pickers, which currently offer every school subject for
   any class the tutor holds:
   - `src/app/(tutor)/tutor/lessons/new/page.tsx`
   - `src/app/(tutor)/tutor/assignments/new/page.tsx`
   Both directions, because these forms pick a class and a subject: given a
   class, offer only subjects they teach in it; given a subject, offer only the
   classes they teach it in. Narrow whenever `assignments` is populated, even
   with the flag off, since showing a teacher 36 subjects they do not teach is
   the actual complaint. ResultPeak's equivalents are `teachableSubjects` and
   `teachableClasses` in its `src/lib/tutorAssignments.js`; mirror their
   behaviour rather than inventing a second rule.

6. `src/app/(tutor)/tutor/page.tsx`: the dashboard is class-first. A subject
   teacher's real question is "how is my Maths doing across JSS1 to JSS3".
   ResultPeak now has a My Subjects screen answering exactly that. Propose the
   equivalent here, do not build it yet.

7. `docs/firestore-rules-to-append.md`: if the `lessons` or `assignments`
   branches need a subject condition, write it there. Do NOT deploy
   `firestore.rules` from this repo. That file is canonical in ResultPeak and
   deploying from here would overwrite a live school's rules.

## What NOT to build

**Attendance already exists in ResultPeak. Do not build a second one.** As of
2026-08-23 ResultPeak owns a flat `/attendance` collection, one document per
class per day, id `{schoolId}_{classId}_{YYYY-MM-DD}`:

```js
{
  schoolId, classId,
  date: "2026-08-23",             // YYYY-MM-DD, the natural key
  academicSession, term,          // stamped from what the SCHOOL states
  entries: { studentId: "present" | "absent" | "late" | "excused" },
  total, presentCount, lateCount, excusedCount, absentCount, attendedCount,
  takenBy,
}
```

Only the named class teacher writes it, enforced in rules. If JDSmartLearn ever
needs attendance, READ this collection; do not write it and do not mirror it.
Two registers for one class on one day is a data problem nobody can untangle
afterwards.

The same goes for term comments and skill ratings, which live in ResultPeak's
`/termNotes` and are class-teacher-only once a school enables allocation.

`classTeacherOf` is otherwise informational here.

ResultPeak additionally holds an allocated tutor to the `classes` audience scope
when creating an exam, because `all` and `cadre` reach classes a rule cannot
enumerate. That has no analog here: lessons and assignments already target one
named class.

## Constraints

- `src/lib/offline/tutor-db.ts` deliberately does not cache `assignedClasses` so
  a revocation applies instantly. `assignedSubjects`, `subjectClasses` and
  `classTeacherOf` get the same treatment: read fresh, never stored on device.
- Students have no Firebase identity, so no security rule can gate them. Every
  student-facing read stays served by Admin SDK route handlers that check the
  session themselves. Nothing here changes that.
- Field ownership on `studentAcademicRecords` is untouched. Do not go near it.
