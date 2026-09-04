# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It asks ResultPeak to turn `schoolPurge.js` from a
one-product cascade into a **two-phase protocol across both products**, so that
"deletion cascades" becomes true for a school on both platforms.

It does **not** ask ResultPeak to delete a JDSmartLearn collection. That is the
central decision and the reason for the whole document — see "Why not just add
the collections to schoolPurge.js" below.

After it ships, JDSmartLearn's follow-up is small and already scoped: implement
`POST /api/admin/school-purge`, add the school tombstone check to its write
routes, and add the CI guard that fails this repo's build when a collection is
added to `src/lib/db/collections.ts` without being added to the purge sweep.

**Ordering: neither side can ship alone.** The endpoint must exist before
ResultPeak calls it, and ResultPeak must revoke tutor claims in phase 0 before
JDSmartLearn's write path is genuinely closed. Build both, agree the shared
secret, then enable phase 2 in one deploy window. Phase 0 (deactivate) is safe
to ship on its own and is worth shipping first.

---

## Context

You are working in **ResultPeak**, a school exam/results platform, live on
Firebase project `resultpilot-ddf7c`.

A sibling product, **JDSmartLearn** (an LMS), runs inside the *same* Firebase
project — same `projectId`, same Auth directory, same Firestore database. It
reads ResultPeak's collections and **never writes to them**. It owns fourteen
collections of its own, and it stores files in **its own Cloudflare R2 bucket
with its own credentials**, which ResultPeak has no access to and should not be
given.

`schoolPurge.js` today deletes ResultPeak's collections and nothing else. For a
school on both products, this survives the purge:

| Collection | Owner | What it holds |
|---|---|---|
| `assignments` | JDSmartLearn | Homework, including marking guides |
| `submissions` | JDSmartLearn | Children's answers, R2 attachment keys |
| `studentProgress` | JDSmartLearn | Per-student per-subject progress |
| `jdCaScores` | JDSmartLearn | Every CA percentage calculated for a child |
| `lessons`, `generatedContent`, `lessonViews`, `schemes`, `topics` | JDSmartLearn | Lesson content and read receipts |
| `jdNotifications`, `jdReadState`, `jdAuditLogs`, `jdSchoolSettings`, `studentLogins` | JDSmartLearn | Announcements, read state, audit, settings, login aliases |
| `studentAcademicRecords` | **Neither** | Exam marks (ResultPeak) + CA (JDSmartLearn) |
| R2 objects | JDSmartLearn's bucket | Lesson files, schemes, submission attachments |

The data policy tells schools that deletion cascades. **That statement is wrong
today for any school on both products**, and the file-storage work now starting
on both sides widens it.

## Hard constraints

- A paying school is running live exams in this project. Nothing here may change
  exam behaviour.
- **No migration or purge runs without a dry-run mode** that reports counts and
  writes nothing.
- Every Firestore query filters by `schoolId` and carries an explicit `.limit()`.
- **ResultPeak must not write, delete, or enumerate a JDSmartLearn collection**,
  and must not hold JDSmartLearn's R2 credentials. See the next section.

---

## Why not just add the collections to schoolPurge.js

It is the obvious fix and it is the wrong one, for the same reason JDSmartLearn
never writes ResultPeak's collections.

1. **The list goes stale silently, which is exactly the bug being fixed.** The
   fourteen collections above are not a fixed set. They live in
   `src/lib/db/collections.ts` in the JDSmartLearn repo and grow when that
   product ships a feature — `jdReadState` and `schemes` arrived in August 2026,
   `jdCaScores` before them. A hardcoded copy in `schoolPurge.js` is correct on
   the day it is written and wrong the next time the other repo ships, with no
   error and no test failing. The current gap *is* that failure mode, already
   happening. Copying the list over just resets the clock on it.
2. **ResultPeak cannot delete the files.** JDSmartLearn's R2 bucket has its own
   credentials, per the boundary being agreed alongside this. A purge that
   deletes `submissions` rows but leaves the attachment objects has deleted the
   index and kept the children's work.
3. **Deletion has product rules attached to it.** A submission is immutable, a
   lesson's R2 object is deleted by the route that deletes the lesson, and the
   shared academic record must not be resurrected mid-purge (see task 3). Those
   invariants are enforced in the other repo's code. A raw `recursiveDelete` from
   here does not know about them.

**So: each side deletes its own data through its own code, and ResultPeak
orchestrates.** The list of JDSmartLearn collections stays in the JDSmartLearn
repo, where a CI guard fails the build if a new one is not covered.

---

# The invariants

Everything below exists to hold these true.

1. **A purge is complete or it is not started.** ResultPeak's cascade does not
   report success until JDSmartLearn has acknowledged its own purge with counts.
   A failed or unreachable JDSmartLearn leaves the school deactivated and
   retryable, never half-deleted.
2. **Nothing can be written into a school that is being purged.** Both products
   stop serving before either starts deleting. A purge that races a live request
   leaves an orphan row that no cascade will ever find again.
3. **The shared academic record is deleted last, and only after JDSmartLearn has
   stopped.** JDSmartLearn writes `studentAcademicRecords` with
   `set(..., { merge: true })`, and a merge-set **recreates a deleted document**.
   Delete it before JDSmartLearn stops and one in-flight finalisation resurrects
   a purged child's record, holding only the CA half, with no school and no
   student to explain it.
4. **A purge is idempotent and evidenced.** The same `purgeId` twice is one
   purge. Every run leaves counts in `adminAuditLogs`, because "we deleted it" is
   a claim the school is entitled to see supported.
5. **Backups are part of the answer, not an exception to it.** See task 5.

---

## Task 1 (P0) — Phase 0: deactivate, separately from delete

Split what is today one destructive action into **deactivate** and **purge**.

`deactivate(schoolId)`:
- Sets `schools/{id}.isActive = false`.
- **Revokes every tutor's custom claims for that school** (`active: false`, or
  your existing revocation). This part is load-bearing and is easy to miss:
  JDSmartLearn's tutor guard reads `role`, `schoolId` and `active` from the
  **custom claim**, never from a document, so setting `isActive` on the school
  document alone does *not* close JDSmartLearn's tutor write path. Its student
  path closes on its own (every refresh re-reads `students/{id}`), but its tutor
  path closes only when you revoke the claim.
- Deletes nothing. Fully reversible.

This is worth shipping on its own, ahead of everything else. Both products stop
serving a deactivated school within one request today.

## Task 2 (P0) — Phase 1: a grace period, named in the data policy

Deactivation starts a clock. Purge runs after it expires — recommend **30 days**,
or whatever the data policy already promises; make the code and the policy agree
rather than picking a new number here. Store `deactivatedAt` and `purgeDueAt` on
the school. A purge before the window closes requires an explicit override flag
and is recorded as such.

## Task 3 (P0) — Phase 2: call JDSmartLearn, then finish

The purge becomes ordered, and the order is the feature.

```
1. Assert the school is deactivated and the grace window has closed.

2. POST https://<jdsmartlearn-host>/api/admin/school-purge
     headers: Authorization: Bearer <JD_PURGE_SECRET>
     body:    { schoolId, purgeId }      // purgeId: a stable uuid per purge
   -> 200 { purgeId, counts: {...}, filesDeleted: n, completedAt }
   -> anything else: STOP. Leave the school deactivated. Retry later.
      Do NOT proceed to step 3.

3. Record JDSmartLearn's counts in adminAuditLogs under this purgeId.

4. Run ResultPeak's own cascade, including:
     - studentAcademicRecords/{schoolId}_{studentId}   (delete the whole doc)
     - schoolBranding/{schoolId}
     - theorySubmissions attachments in ResultPeak's own R2 bucket

5. Record ResultPeak's counts under the same purgeId.
```

Notes on the details that matter:

- **`JD_PURGE_SECRET` is a server-side shared secret**, held in both projects'
  environment. Never in client code, never prefixed for client exposure. Rotate
  it like any other credential.
- **Step 2 is retryable and idempotent.** JDSmartLearn keys on `purgeId` and
  returns the original counts for a repeat.
- **Step 4 deletes `studentAcademicRecords` and JDSmartLearn does not.** That
  document is owned by neither platform, and it is keyed `{schoolId}_{studentId}`
  — ResultPeak already enumerates students, JDSmartLearn would have to read the
  roster to find them. JDSmartLearn's write guard is a field allowlist over a
  *live* document; giving it a delete path to that collection would be the wrong
  thing to widen. Delete the whole document from here, after the ack, per
  invariant 3.
- **A timeout is not a failure to swallow.** A timeout on step 2 means unknown,
  which is treated as failure: stop, retry, and let idempotency sort it out.

## Task 4 (P1) — Dry run and a reconciliation report

- `--dry-run` on the whole protocol. JDSmartLearn's endpoint takes the same flag
  and returns counts without deleting.
- A read-only report, runnable at any time, that lists schools where ResultPeak
  has no school document but JDSmartLearn still reports rows — the schools
  already purged under the old behaviour. **Report only; do not auto-purge them.**
  Deciding to delete a former customer's data on the strength of a script's
  opinion is a decision a person makes once, with the counts in front of them.

## Task 5 (P1) — Say what backups mean for deletion

ResultPeak is moving this project to Blaze for scheduled Firestore backups.
Backups retain a deleted school's data for the backup retention window, and a
Firestore backup covers the **whole database** — both products' collections.

So the data policy needs a sentence it does not have today: deletion removes the
data from the live database within *N* days, and from backups within the backup
retention window. Pick that retention deliberately rather than accepting a
default, because the number is now a promise made to a school. This is a policy
change as well as a code change — route it to whoever owns the policy text.

---

## What JDSmartLearn has already done

Built and merged before this prompt was handed over, so the counts below are real
rather than estimated:

- **`npm run report:purge -- <schoolId>`** — a read-only report of exactly what a
  purge would remove on this side: every collection, its row count, and the R2
  objects those rows point at. It writes nothing, and the Firestore handle it
  holds throws on every write method, so it cannot quietly become a migration.
  This is the dry-run half of task 4, available to run against any school today.
  Run against CAPSTONE ACADEMY on 2026-09-03: **97 rows, 2 files, 18 reads.**
- **The drift guard.** Every collection in `src/lib/db/collections.ts` must
  appear in the purge plan or this repo's build fails. This is the structural fix
  for the defect being reported — a collection added next year is covered on the
  day it is added, without anyone in either repo remembering this document
  exists. It is also why ResultPeak should not keep its own copy of the list.
- **School-prefixed storage keys.** New lesson files are written to
  `lessons/{schoolId}/{lessonId}/original{ext}`, matching schemes and submission
  attachments, so every new object is prefix-scannable by school and a purge can
  be *verified* rather than merely executed. Historic keys are untouched and keep
  working: the key is always read from the document, never rebuilt.

## What JDSmartLearn does after this ships

- Implements `POST /api/admin/school-purge`: bearer-auth on `JD_PURGE_SECRET`,
  idempotent on `purgeId`, dry-run supported. Deletes its fourteen collections by
  `where("schoolId","==",id).limit(200)` in paged batches, deletes the matching
  R2 objects from its own bucket, returns per-collection counts. The enumeration
  and the counting already exist; what is missing is deliberately the deleting.
- Adds a **school tombstone** check to its write routes, so a purged or
  deactivated school is refused on this side too, independently of claim
  revocation. Belt and braces, because the two products revoke by different
  mechanisms and only one of them is instant.

## Definition of done

- [ ] Deactivate and purge are separate actions, with a grace window between them
- [ ] Deactivate revokes tutor custom claims, not just `schools/{id}.isActive`
- [ ] The purge stops and stays retryable if JDSmartLearn does not acknowledge
- [ ] `studentAcademicRecords` is deleted only after that acknowledgement
- [ ] `schoolBranding/{schoolId}` is deleted in the cascade (it already is — keep it)
- [ ] The same `purgeId` twice deletes once
- [ ] Counts from both products land in `adminAuditLogs`
- [ ] `--dry-run` works end to end and writes nothing
- [ ] No JDSmartLearn collection is read, written or enumerated from this repo
- [ ] The data policy states the live-deletion window and the backup window
