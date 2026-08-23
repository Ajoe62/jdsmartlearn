# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It asks ResultPeak to own the list of subjects a class
offers — a fact ResultPeak's own product needs and currently derives by accident,
and which JDSmartLearn cannot derive correctly at all.

**Ordering: JDSmartLearn ships first and is not blocked by this.** JDSmartLearn's
student subject shelf is live today on a derived list (the union of tutor
allocations with the subjects that actually have a lesson or an assignment). That
derivation is labelled a workaround in
`src/lib/db/class-subjects.ts` and it is wrong in one specific, visible way: a
subject a class genuinely offers but which has no tutor allocated yet and no
content uploaded yet **does not appear on the child's shelf**. It looks to a
parent like the school dropped a subject.

After this ships, JDSmartLearn's follow-up is small and already scoped: make
`getClassSubjects()` read `classes/{classId}.subjectIds` when present and fall
back to the derivation only when it is absent, then delete the derivation and
its cached tutor-allocation scan once every class in every pilot school has the
field.

---

## Context

You are working in **ResultPeak**, a school exam/results platform, live on
Firebase project `resultpilot-ddf7c` (Spark plan), with a paying school running
real exams in it.

A sibling product, **JDSmartLearn** (an LMS for the same Nigerian primary and
secondary schools), runs inside the *same* Firebase project — same `projectId`,
same Auth directory, same Firestore database. It reads ResultPeak's collections
and never writes to them.

JDSmartLearn has just shipped a **student subject shelf**: a dashboard where a
child sees every subject they offer, with their lessons, schemes of work,
assignments and grades grouped under each one, filterable by term and session.
It is the screen parents look at.

Building it surfaced a gap on the ResultPeak side.

## The gap

**There is no record anywhere in this project of which subjects a class offers.**

What exists today:

| Where | What it holds | Why it is not the answer |
|---|---|---|
| `schools/{schoolId}.subjects[]` | `{ id, name }[]` for the whole school | School-wide. An SS2 science class and a JSS1 class read identically from it. |
| `classes/{classId}` | `name`, `schoolId`, `isActive`, sometimes `level` | No subjects at all. |
| `schools/{schoolId}/tutors/{uid}.subjectClasses` | `subjectId -> classId[]` | The only class-to-subject link in the project — but it is a **staffing** record, not a **curriculum** record. See below. |
| `exams`, `results` | Per-exam subject references | Retrospective. A subject that has not been examined yet does not exist in it. |

**Why the tutor allocation is not a substitute.** It answers "who teaches what",
not "what is taught". The two diverge constantly and in both directions:

- A subject with no tutor allocated yet — a vacancy, a new hire in progress, a
  subject the head teacher covers personally — is a subject the class **offers**
  and the allocation **does not list**.
- The allocation is optional and mostly unset. JDSmartLearn's own
  `isUnallocated()` treats an empty allocation as "every subject", because most
  tutors in the live school have not been allocated. That fallback is right for
  an authorization check (fail toward the behaviour that shipped) and useless as
  a curriculum source: it says every class offers every subject in the school.
- A tutor leaving does not mean a subject stops being offered, but it does empty
  the allocation.

So JDSmartLearn currently unions the allocation with observed content, and a
subject that is offered but has neither yet is invisible to the child.

**This is your product's gap too, not only ours.** ResultPeak builds a result
sheet per student per term. Which subjects belong on that sheet is presently
answered by "whichever ones happen to have an exam", which is why a subject
examined in first term and not in second silently changes the shape of a child's
sheet between terms.

## Hard constraints

- A paying school is running live exams in this project. Nothing here may change
  exam behaviour, and no migration may run without a dry-run mode.
- Every Firestore query filters by `schoolId` and carries an explicit `.limit()`
  — the Spark quota is shared with JDSmartLearn.
- **Never remove or rename `schools/{id}.subjects[]`.** JDSmartLearn joins on
  `subject.id` from it in `topics`, `lessons`, `assignments`, `studentProgress`
  and `studentAcademicRecords.continuousAssessment`. Those ids are the join key
  for a paying school's continuous assessment. They must stay byte-identical.
- The new field is **additive and optional**. JDSmartLearn must keep working for
  every class that does not have it yet, for as long as any such class exists.

---

# The invariant

> **A class's subject list is a curriculum fact stated by a school admin, not a
> fact inferred from staffing or from content that happens to exist.**

Everything below exists to hold that true. Enforce it in code, not in a
convention: the whole reason this document exists is that the fact was inferable
in three different ways and all three disagreed.

---

## Task 1 (P0) — The field

Add to `classes/{classId}`:

```ts
subjectIds: string[]   // subject.id values from schools/{schoolId}.subjects[]
```

Rules for it, and please write them as comments on the write path rather than
only here:

1. **Every id must exist in that school's `subjects[]` at write time.** Refuse
   the write otherwise — a typo here becomes a subject a child sees on a shelf
   with nothing ever in it, and it is not obviously wrong to anyone looking.
2. **Ids only, never names.** A denormalized name goes stale the moment a school
   renames a subject, and JDSmartLearn resolves names from `subjects[]` on read
   already.
3. **Absent is not empty.** A class that has never been configured must be
   distinguishable from a class an admin deliberately set to no subjects. Leave
   the field **undefined** until an admin saves it the first time; do not
   backfill it to `[]`. JDSmartLearn branches on exactly this: undefined means
   "fall back to the derivation", `[]` means "this class genuinely offers
   nothing, show the empty state".
4. **Order is meaningful and is the admin's.** Store it as they arrange it;
   JDSmartLearn renders the shelf in this order rather than alphabetically, so a
   school can put core subjects first.

## Task 2 (P0) — The admin surface

Wherever a school admin edits a class today, add subject selection:

- Multi-select over that school's `subjects[]`, showing the subject name,
  writing the id.
- **Bulk apply across classes.** A Nigerian secondary school sets one subject
  list for all of JSS1–JSS3 and another for each SS stream. Making an admin
  repeat a twelve-subject selection per class is how the field ends up half
  filled, and a half-filled field is worse than an absent one because the
  fallback stops running for exactly the classes someone touched.
- **Copy from another class** as the fast path.
- Empty state: say plainly that until subjects are set, JDSmartLearn shows each
  class the subjects it can see from tutor allocations and uploaded content, and
  may be missing some.

## Task 3 (P1) — Use it on the result sheet

Make the result sheet's subject rows come from `subjectIds` when the class has
it, falling back to the current exam-derived behaviour when it does not. This is
the task that makes the field yours rather than a favour to us: it fixes the
sheet changing shape between terms.

Do not do this before Task 2 has been used by a real school on real data — a
result sheet driven by an empty list is a blank sheet.

## Task 4 (P2) — Backfill the school already loaded

One school is live. Write it as a **dry-run-first script**, in the shape the
repo already uses:

- Propose `subjectIds` per class as the union of that class's tutor allocations
  and the subjects appearing in its exams.
- **Print the proposal and write nothing** without an explicit `--apply`.
- Never overwrite a `subjectIds` an admin has already saved.

The proposal is a starting point for a human, not an answer. Hand the printout
to the school and have them correct it in the Task 2 UI. That is the entire
reason Task 2 comes first.

## Task 5 (P1) — Rules

`classes` is already ResultPeak-owned and JDSmartLearn reads it read-only. The
new field needs no new match block, but confirm the existing `classes` read rule
covers JDSmartLearn's tutors and admins — they read class documents through the
Admin SDK on server routes today, so this is defence in depth rather than a
functional dependency.

**Do not add a public read branch** for the subject list. JDSmartLearn's student
routes reach class data through server routes with a minted session cookie;
students have no Firebase Auth identity at all.

---

## What JDSmartLearn does after this ships

Nothing on the day. Then, in one small change:

1. `getClassSubjects(schoolId, classId)` reads `classes/{classId}.subjectIds`
   and uses it when it is an array, falling back to the current derivation when
   the field is undefined.
2. The shelf's "some subjects may be missing" notice stops rendering for classes
   that have the field.
3. Once every class in every pilot school has it, the whole derivation goes,
   along with `getSchoolAllocation()` - the cached scan of
   `schools/{id}/tutors` that exists only to feed it. No collection to drop and
   no rules block to remove: the derivation was deliberately never persisted.

Tell us when it ships and which schools have been configured; the fallback stays
in place until then and costs nothing.

## Definition of done

- [ ] `subjectIds` written only after validating every id against that school's
      `subjects[]`
- [ ] Undefined and `[]` are distinguishable, and both are handled deliberately
- [ ] An admin can set twelve subjects across six classes without twelve × six
      clicks
- [ ] Backfill script is dry-run by default and never overwrites an admin's save
- [ ] No change to `schools/{id}.subjects[]` ids
- [ ] No exam behaviour changed
- [ ] Every new query filtered by `schoolId` and `.limit()`ed
