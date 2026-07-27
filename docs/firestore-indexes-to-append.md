# Firestore indexes to append (DO NOT DEPLOY FROM THIS REPO)

`firestore.indexes.json` is **project-level**, exactly like `firestore.rules`.
Running `firebase deploy --only firestore:indexes` from JDSmartLearn would
overwrite ResultPeak's index set and could **delete indexes their live exams
depend on**. Never deploy indexes from this repo.

## Current status: JDSmartLearn needs NO composite indexes

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

## Note: existing manually-created indexes are now unused

The `lessons (schoolId, tutorId, updatedAt)` and
`generatedContent (lessonId, version)` composite indexes that were created via
the console error links are **no longer required** by the code. They are
harmless to leave in place; they can also be removed from the project's index
set when convenient.
