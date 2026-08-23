# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. Subject allocation has already shipped there; this
asks for the two pieces JDSmartLearn now depends on and cannot see from its own
side — a way for a school to actually switch enforcement on, and a guarantee
about the order the derived fields are written in.

Nothing here blocks JDSmartLearn. Its half is shipped and inert:
`schools/{id}.subjectAllocation` is absent on all four schools in the project,
absent means off, and off is exactly today's behaviour. The work below is what
turns the feature on safely for the first school that wants it.

---

## Context

You are working in **ResultPeak**, a school exam and results platform, live with
paying schools. It shares one Firebase project (`resultpilot-ddf7c`) — same Auth
directory, same Firestore — with a second product, **JDSmartLearn**, an LMS used
by the same tutors in the same schools. Different repository, no shared code.

ResultPeak recently moved tutor scoping from class alone to `(classId,
subjectId)` pairs. `schools/{schoolId}/tutors/{uid}` gained:

```js
assignments:      [{ classId, subjectId }, ...],   // the authored truth
subjectClasses:   { subjectId: [classId, ...] },   // derived
assignedSubjects: [subjectId, ...],                // derived
classTeacherOf:   [classId],                       // capped at one entry
assignedClasses:  [classId, ...],                  // UNCHANGED derived union
```

and enforcement is gated per school on `schools/{schoolId}.subjectAllocation`,
where **absent means off**.

JDSmartLearn has now implemented the matching half. It reads
`subjectAllocation`, `subjectClasses` and `assignedSubjects` and applies this
truth table on every route that accepts a subject from a tutor:

| School flag | Tutor allocation | Behaviour |
| --- | --- | --- |
| off | empty | allow everything (every school today) |
| off | populated | allow, but narrow the pickers |
| on | populated | enforce the pair |
| on | empty | **refuse everything** |

## Current state, verified against production on 2026-08-23

Read directly from Firestore, not assumed:

- **Four** schools exist (`schools` `count()` = 4), all `isActive: true`. All
  four have `subjectAllocation` **absent**, so nothing is enforced anywhere.
- **Three** tutors have `assignments` populated: two in CAPSTONE ACADEMY
  (`U9SJpzzKUtF6S9V8cG7D`), one in Mt. Cedar (`dV6zL3AEydAFJc3D3GrO`).
- On all three, `subjectClasses` and `assignedSubjects` are consistent with
  `assignments`. No half-derived profiles.
- `classTeacherOf` is `[]` everywhere.
- Each backfilled tutor holds **every subject in their school** across every
  class they hold (36 pairs for the Mt. Cedar tutor; 42 for each CAPSTONE one).

That last point matters for expectations: the backfill spelled out full
pre-existing access literally, so narrowing a picker changes nothing visible
until a human edits an allocation down. If someone reports "the subject list is
still 36 long", that is the data, not a bug in either product.

## Hard constraints

- **Do not change the shape of the four fields above.** JDSmartLearn reads
  `subjectClasses` and `assignedSubjects` directly and matches on `subjectId`
  being the slugified id from `schools/{id}.subjects[]`.
- **`assignedClasses` must keep its exact current meaning** — the derived union
  of every class in `assignments`. Both products still scope by it first;
  subject checks narrow it, never replace it.
- **Absent must keep meaning off.** Do not backfill `subjectAllocation: false`
  onto existing schools to "make it explicit". JDSmartLearn tests
  `=== true`, so a backfill is harmless there, but it destroys the distinction
  the field exists for, and any future reader that tests `'subjectAllocation' in
  school` would then see every school as having opted in.

## Task 1 (P0) — A way to switch it on, and off again

Enforcement currently has no user-facing control that we can find from this
side. Before any school can use the feature, a school admin needs to set
`schools/{schoolId}.subjectAllocation`, see its current state, and — the part
that matters more — **turn it off again quickly**.

Requirements:

- A school-admin-only control. Not superadmin-only: the person who discovers
  that allocations are wrong is the school's own admin, at the moment their
  teachers start complaining.
- Turning it **on** must warn how many tutors in that school currently have
  empty `assignments`, and state plainly that those tutors will be able to
  author nothing until they are allocated. That number is the blast radius and
  it should be on screen before the confirm, not after.
- Turning it **off** must take effect promptly. JDSmartLearn caches the flag for
  60 seconds, so a school that panic-disables waits at most a minute; please do
  not add caching on top of that.

## Task 2 (P0) — Write `assignments` and the derived fields in one transaction

JDSmartLearn treats a profile with `assignments` populated but `subjectClasses`
or `assignedSubjects` empty as **unallocated**, and under enforcement that means
**locked out** — the tutor can author nothing until the derive completes.

That is a deliberate decision on our side (a stalled derive should be a support
call, not a silent widening of access), but it makes your write ordering
load-bearing in a way it was not before. A profile that sits half-written for
even a few seconds is, for that window, a teacher who cannot create a lesson.

Please confirm — and make true if it is not:

- `assignments` and all three derived fields are written in **one** atomic
  write (a single `set`/`update`, or a transaction/batch), never as a write
  followed by a separate derive.
- If any derive happens in a background job, a Cloud Function trigger, or a
  separate client round-trip, say so in your reply. If it cannot be made atomic,
  we need to know, because our fail-closed choice would then need revisiting on
  our side.

## Task 3 (P1) — Do not let a school enforce with nobody allocated

The trap row is enforcement on with allocations empty: it holds the entire
school. Task 1's warning covers the informed case. This is the guardrail for the
uninformed one.

Suggested: refuse to enable `subjectAllocation` when **no** tutor in the school
has a populated `assignments`, with a message pointing at the allocation screen.
A school with some tutors allocated and some not should still be able to
proceed — that is a legitimate rollout — but a school with zero allocations is
always a mistake.

## Task 4 (P2) — Confirm the rules position

JDSmartLearn has **deliberately not** mirrored the subject check into Firestore
rules, and has written down why:
`docs/firestore-rules-to-append.md`, section "Considered and rejected: a subject
condition on `lessons` and `assignments`". Short version — every JD collection is
`allow write: if false` (Admin SDK only), the tutor read branches are already
narrower (`tutorId == request.auth.uid`), and a rule would now need **two**
`get()`s per document evaluated (school flag plus tutor profile) to encode a
four-row table in a language where a missing field is an error and an erroring
rule denies.

Nothing is being asked of `firestore.rules` for JDSmartLearn's sake. If
ResultPeak's own branches need a subject condition for ResultPeak's own reads,
that is your call and lives entirely in your canonical rules file. Please just
confirm you are not expecting JDSmartLearn to supply one.

## What JDSmartLearn does after this ships

Nothing, in code. Our half is already deployed and inert while the flag is
absent. Once Task 1 exists:

1. A school allocates its tutors in ResultPeak.
2. That school's admin switches `subjectAllocation` on.
3. Within 60 seconds, JDSmartLearn starts enforcing pairs for that school only.

We would like to be told before the first school switches it on, so we can watch
for lockouts rather than hear about them from a teacher.

## Definition of done

- [ ] A school admin can see and change `subjectAllocation` for their school
- [ ] Enabling warns with the count of unallocated tutors before confirming
- [ ] Disabling takes effect without additional caching on your side
- [ ] `assignments` and all three derived fields are written atomically —
      confirmed, in the reply, with the file and line that does it
- [ ] Enabling is refused when no tutor in the school is allocated
- [ ] Confirmation that no rules change is expected from JDSmartLearn
- [ ] `assignedClasses` still means the derived union of every class in
      `assignments`, unchanged
