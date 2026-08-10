# Firestore indexes to append (DO NOT DEPLOY FROM THIS REPO)

`firestore.indexes.json` is **project-level**, exactly like `firestore.rules`.
Running `firebase deploy --only firestore:indexes` from JDSmartLearn would
overwrite ResultPeak's index set and could **delete indexes their live exams
depend on**. Never deploy indexes from this repo.

## Current status: JDSmartLearn needs NO composite indexes

Still true after the assessment feature (assignments, submissions, progress).
See "How the assessment queries hold the line" at the end of this file.

Every JDSmartLearn query is deliberately shaped to avoid composite indexes —
either a single-field/equality-only filter, or equality filters with the sort
done in memory. So there is **nothing to append** to ResultPeak's
`firestore.indexes.json` today, and no `create_composite=...` link should appear
for a JD query. Keep it that way.

### The rule for new queries

A Firestore query needs a composite index when it combines **either**:

- multiple fields where one uses `orderBy`, **or**
- an equality filter with a range/inequality (`>`, `>=`, `<`, `<=`) on a
  *different* field.

Queries with only equality filters (any number of them) do **not** need a
composite index. So when you add a query:

1. Prefer equality-only filters, then `.sort()` the (bounded, `.limit()`ed)
   result in memory — see `listLessonsForTutor`, `listTopics`,
   `listVisibleLessonsForClass`, `getGeneratedContent` in `src/lib/db/`.
2. To bucket by time (e.g. a daily cap), store a `dateKey` string
   (`"YYYY-MM-DD"`) and filter it with `==`, instead of a `createdAt >= start`
   range. See `countGenerationsToday` / `writeAuditLog`.

Only if a query genuinely cannot avoid a composite index: add its definition
here in `firestore.indexes.json` shape, then open a PR to append it to the
canonical file in the **ResultPeak repo** and deploy from there. Do not
`firebase deploy` from this repo, and do not rely on console-created indexes as
the source of truth (a later ResultPeak deploy would prune them).

## How the assessment queries hold the line

Every query the assessment feature adds is equality-only, sorted in memory, and
`.limit()`ed. None needs a composite index.

| Where | Query | Sort |
|---|---|---|
| Student, Pending tab | `assignments` where `schoolId`, `classId`, `isActive` | `dueDate` in memory |
| Student, Submitted and Graded tabs | `submissions` where `schoolId`, `studentId` | `submittedAt` in memory, status filtered in memory |
| Student progress page | `studentProgress` where `schoolId`, `studentId` | subject name in memory |
| Tutor, submissions table | `submissions` where `schoolId`, `assignmentId` | `submittedAt` in memory |
| Tutor, assignment list | `assignments` where `schoolId`, `tutorId` | `dueDate` in memory |
| CA recalculation | `submissions` where `schoolId`, `studentId`, `subjectId`, `term`, `session`, `status` | none |
| Class activity feed | `jdNotifications` where `schoolId`, `audience`, `targetId` | `createdAt` in memory |
| Admin settings, observed sessions | `exams` where `schoolId`; `results` where `schoolId` | tallied in memory |

### Why the CA query filters on `session` as well as `term`

A Nigerian school year spans two calendar years, and ResultPeak's own
`defaultSession()` returns the NEXT session from January to August (see
`docs/resultpeak-defects.md`, defect 1). The live project already contains
`"Third Term"` under two different session strings for the same school. Filtering
on term alone would average a child's third term across two academic years, and
the error would grow quietly year on year rather than fail.

Six equality filters, no range, no `orderBy`. Still no composite index.

### Verified empirically on 2026-08-10, not reasoned about

Both live queries were run against the real project read-only at `limit(1)`. A
query with no index fails with `FAILED_PRECONDITION` and costs no reads, so this
is a safe way to get a definitive answer.

| Query | Result |
|---|---|
| Sweep as implemented: `schoolId ==`, `assignmentId ==`, `status in [...]` | **OK, no index** |
| `listFinalisedForSubject`: six equality filters | **OK, no index** |
| Control: `results` with `schoolId ==` + range + `orderBy` | `FAILED_PRECONDITION` as expected |

The control matters: it proves the probe can detect the condition at all, so the
two OK results are real and not a probe that never fails.

**The Firestore emulator cannot answer this question.** All five shapes passed
there, including two that provably need indexes in production. Do not use the
emulator to decide whether an index is needed.

### The index the sweep would have needed, and why it does not

The obvious sweep is `schoolId ==`, `status in [...]`, `lastGradingAttemptAt <=
cutoff`. That combines equality filters with a range on a different field, and
production confirms it:

```
FAILED_PRECONDITION: The query requires an index.
```

Decoded from that error, the index would be:

```jsonc
{ "collectionGroup": "submissions",
  "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "schoolId",             "order": "ASCENDING" },
              { "fieldPath": "status",               "order": "ASCENDING" },
              { "fieldPath": "lastGradingAttemptAt", "order": "ASCENDING" } ] }
```

**It is not needed, because the sweep does not use that shape.** It filters
equality-only, scoped to one assignment, and applies the staleness comparison in
memory over a `.limit(50)` result set. One assignment is one class, roughly forty
documents. See `candidates()` in `src/lib/db/grading-sweep.ts`.

If a school-wide sweep is ever wanted, the range shape becomes necessary and that
index above is the one to append. Today it is not, and the repo keeps its
zero-composite-index property.

### Collection group scope really does break the equality-only assumption

Worth recording, because it justifies keeping `submissions` flat. A
collectionGroup query with a **single equality filter** was run against
production:

```
FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_ASC index
for collection questions and field topicId.
```

One filter. Automatic single-field indexes are collection-scoped, so collection
group scope needs its own index for even the simplest query. Had `submissions`
been nested under `assignments`, the student tabs would have been blocked behind
a cross-repo index PR before a single child could open them.

**There are no collectionGroup queries in this codebase, and there should not be.**

### A note on the filename

Task 2 of the original brief asked for `docs/firestore-indexes-to-add.md`. This
file is that document. It was already named `-to-append` to match
`firestore-rules-to-append.md`, and both names describe the same process: the
contents get appended to the canonical file in the ResultPeak repo by pull
request and deployed from there. One file, not two with near-identical names.

### The collectionGroup query we deliberately did not write

Nesting submissions as `assignments/{id}/submissions/{studentId}` was the
obvious shape, and it was rejected. The student's Submitted and Graded tabs must
filter on `schoolId` and `studentId` across every assignment, which as a
collection group query needs:

```jsonc
{ "collectionGroup": "submissions",
  "queryScope": "COLLECTION_GROUP",
  "fields": [ { "fieldPath": "schoolId",  "order": "ASCENDING" },
              { "fieldPath": "studentId", "order": "ASCENDING" } ] }
```

Firestore's automatic single-field indexes have collection scope, not collection
group scope, so that index is not created for you. It would have to be appended
to the canonical `firestore.indexes.json` in the **ResultPeak repo** and deployed
from there before a single student could open the tab, which puts a student-facing
feature behind a cross-repo pull request and a deploy against a live paying
school's project.

A flat `submissions/{assignmentId}_{studentId}` avoids all of it, matches the
"flat top-level collections" convention in CLAUDE.md, and makes the
duplicate-submission check one `get()` instead of a query. **Do not move
submissions under assignments.**

## Note: existing manually-created indexes are now unused

The `lessons (schoolId, tutorId, updatedAt)` and
`generatedContent (lessonId, version)` composite indexes that were created via
the console error links are **no longer required** by the code. They are
harmless to leave in place; they can also be removed from the project's index
set when convenient.
