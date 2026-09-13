# ResultPeak defects found from the JDSmartLearn side

Defects in ResultPeak, found while building against the shared Firebase project.
Each one affects ResultPeak on its own, independently of JDSmartLearn.

**Nothing here is fixed from this repo.** JDSmartLearn is read-only on every
ResultPeak collection, and its frontend lives in another repository. This file
exists so these do not get lost, and so a JDSmartLearn workaround is never
mistaken for the real fix.

Related: `docs/firestore-rules-to-append.md` carries the rules and the
`manualScores` idempotency requirement that ResultPeak must also action.

---

## 1. `defaultSession()` returns the wrong session for two thirds of the year

**Severity: high. Silently splits a single academic year across two result sheets.**

### What it does

```js
function defaultSession() {
  const y = new Date().getFullYear();
  return `${y}/${y + 1}`;
}
```

Duplicated in three places:

- `src/components/exams/ExamForm.tsx:93` as `defaultSession()`
- `src/pages/admin/ManageExamsPage.jsx:38` as `getDefaultAcademicSession()`
- `src/components/exams/ExamCoverageGrid.tsx:41` as `currentSession()`

### Why it is wrong

A Nigerian academic session spans two calendar years, starting around September.
So from **January to August** the session in progress is `(y-1)/y`, not `y/(y+1)`.
The function returns the session that has not started yet.

Concretely, on 10 August 2026 the school is finishing session **2025/2026**, and
this function offers **2026/2027**.

### It is already in the live data

Sampling `results` in the shared project on 2026-08-10 returned documents
carrying `term: "Third Term"` with `academicSession: "2026/2027"`. Third term of
2026/2027 cannot have happened yet. Those rows are the date default misfiring and
being accepted, because `academicSession` is a free-text input with no validation.

Sixty sampled `exams` for the same school split three ways:

```
54x  "Third Term" | "2025/2026"
 5x  "First Term" | "2026/2027"
 1x  "First Term" | "2025/2026"
```

### The consequence

`getTermKey()` in `src/lib/termResultData.js` joins a result sheet on the literal
strings:

```
studentId__schoolId__classId__academicSession__term
```

So a first term recorded under `2026/2027` and a second and third term recorded
under `2025/2026` are **three separate result sheets for one child in one school
year**. Nothing errors. Each sheet renders correctly and looks complete. The only
symptom is a missing term that an operator has to notice by eye.

### Suggested fix

Derive from the month, not the year alone, and put it in one place instead of
three:

```js
export function currentAcademicSession(now = new Date()) {
  const y = now.getFullYear();
  // Sessions start around September. Before then, the session began last year.
  return now.getMonth() >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}
```

Better still, make the current session a per-school setting rather than a
calculation, since school calendars shift and no formula fits all of them. See
defect 2.

Either way the existing rows need a decision: a migration, or an admin tool that
merges two session strings into one for a class.

### The annual average makes this worse, and the count as of 2026-08-13

ResultPeak is gaining an end-of-session annual average computed from the three
term percentages. It joins the terms by exact string match, so a term recorded
under the wrong session does not error and does not blank the figure: it drops
out of the average, and a plausible number prints without it. Today the symptom
is a missing column an operator might notice. With the annual average it becomes
a wrong number nobody can see is wrong.

`npm run diagnose:terms <schoolId>` reports this per school, read-only. Run
against every school in the project on 2026-08-13:

| School | Pairs in `exams` and `results` |
|---|---|
| CAPSTONE ACADEMY | 2811 rows, all `Third Term` / `2025/2026`. Clean. |
| HIGHER GROUND INTERNATIONAL | `First Term` / `2025/2026` (4), `Third Term` / `2025/2026` (1). Clean. |
| Mt. Cedar British International | 6 rows, all `First Term` / `2026/2027`. |
| Dlink Academy (ActiveBrains) | **`Third Term` split**: `2026/2027` (34), `2025/2026` (31). |
| YpnConnect | **`Third Term` split**: `2025/2026` (11), `2026/2027` (10). Plus `First Term` / `2026/2027` (4). |
| Tech School | **`Third Term` split**: `2025/2026` (1), `2026/2027` (1). |

**51 rows carry `2026/2027`**, a session that has not started, which is
`defaultSession()` misfiring exactly as described above. Three schools have one
term of one school year already divided across two result sheets. A JDSmartLearn
assignment can join to only one side of each split, whichever session string the
school's setting carries at the time it is created.

The 2026-08-10 sample above ("sixty exams split three ways") was taken across
schools rather than within one, which is why its shape differs from this table.
Per school is the unit that matters, because a result sheet is per school.

---

## 2. No record of which term and session is current

**Severity: medium. Every school-wide setting is retyped per exam.**

There is no field anywhere recording the current term or academic session:

- `schools/{id}` has no such field. Its keys are `name`, `slug`, `address`,
  `isActive`, `createdBy`, `createdAt`, `assessmentTypes`, `contactEmail`,
  `logo`, `contactPhone`, `gradingScale`, `subjects`.
- No settings-style collection exists. Checked and absent: `settings`,
  `schoolSettings`, `sessions`, `academicSessions`, `schoolConfig`, `config`,
  `appSettings`, `terms`, `calendar`.
- No `currentTerm`, `activeTerm`, `currentAcademicSession` or `activeSession`
  anywhere in the ResultPeak source.

Terms are a hardcoded frontend array, duplicated in three files:

- `src/components/exams/ExamCoverageGrid.tsx:39`
- `src/components/exams/ExamForm.tsx:20`
- `src/pages/admin/ManageExamsPage.jsx:36`

So "which term is it" is answered by whatever an operator last typed onto an
exam, and defect 1 supplies a wrong default for that answer eight months a year.

**JDSmartLearn's stopgap:** it holds `jdSchoolSettings/{schoolId}` with the
current term and session, set by a school admin, who picks the session from
values observed in that school's own `exams` and `results` rather than typing
one. Read behind a single function, `getCurrentTermSession()`, so the source can
move to ResultPeak in a one-file change. **That stopgap should be deleted once
ResultPeak owns the field.**

---

## 3. `students` documents are world-readable

Already recorded in `docs/firestore-rules-to-append.md`, repeated here so this
file is the full list. Any `students` document with `isActive == true` is
currently readable without authentication, exposing minors' names, admission
numbers and classes.

---

## 4. Exam questions are not tagged by topic

Already recorded in `docs/firestore-rules-to-append.md`. Without `topicId` on
`exams/{examId}/questions/{qid}`, and stamped into `results.answers[]` at
submission, topic-level revision recommendations cannot be derived from exam
results and untagged history can never be back-filled.

---

## 5. `schoolPurge.js` deletes no JDSmartLearn collection

**Severity: high. The data policy tells schools deletion cascades, and for a
school on both products it does not.**

Reported by the ResultPeak side on 2026-09-03, recorded here because it affects
ResultPeak on its own: the promise in the policy is ResultPeak's, and it is
untrue today for any school using both products.

When a school is purged, all of this survives: `assignments` (with marking
guides), `submissions` (children's answers), `studentProgress`, `jdCaScores`,
`lessons`, `generatedContent`, `lessonViews`, `schemes`, `topics`,
`jdNotifications`, `jdReadState`, `jdAuditLogs`, `jdSchoolSettings`,
`studentLogins`, every R2 object behind them, and the JDSmartLearn half of
`studentAcademicRecords`.

**The fix is not a longer list in `schoolPurge.js`.** That is the same failure
with the clock reset: the collection list lives in `src/lib/db/collections.ts` in
*this* repo and grows when this product ships, so a hardcoded copy over there
goes stale silently — which is how this defect happened. Nor can ResultPeak
delete the R2 objects; that bucket has its own credentials and, under the storage
boundary agreed on 2026-09-03, should stay that way.

The protocol is in `docs/resultpeak-deletion-protocol-prompt.md`: deactivate,
grace window, ResultPeak calls a JDSmartLearn purge endpoint and waits for counts,
then finishes its own cascade. Two ordering constraints in it are load-bearing
and are the parts most likely to be dropped as detail:

- **Deactivating a school does not close this repo's tutor write path.** The
  tutor guard reads `active` from a **custom claim**, never from a document, so
  `schools/{id}.isActive = false` does not stop a tutor mid-session. ResultPeak
  must revoke claims. (The student path closes on its own —
  `refreshStudentSession()` re-reads `students/{id}` every 12 hours.)
- **`studentAcademicRecords` must be deleted after this repo has stopped, never
  before.** `writeContinuousAssessment` uses `set(..., { merge: true })`, and a
  merge-set **recreates a deleted document**. Delete it first and one in-flight
  finalisation resurrects a purged child's record carrying only the CA half.

### Found from this side while scoping it

R2 keys in this repo are not uniformly school-scoped:

| Key | Prefix-scannable by school |
|---|---|
| `schemes/{schoolId}/{schemeId}{ext}` | yes |
| `submissions/{schoolId}/{assignmentId}/{studentId}/{n}{ext}` | yes |
| `lessons/{lessonId}/original{ext}` | **no** |

Document enumeration is the correct primitive for a purge either way — the
`fileKey` on the document is the source of truth, not a prefix listing. But
without the prefix there is no cheap way to *verify* afterwards that a school's
lesson files are gone.

**Fixed on this side, 2026-09-03.** New lesson files are written to
`lessons/{schoolId}/{lessonId}/original{ext}` through the shared builders in
`src/lib/storage/keys.ts`, which all four upload routes now use. Historic keys
are untouched and keep working, since the key is always read from the document
and never rebuilt from parts; `prefixedBySchool` stays `false` for `lessons` in
the purge plan until those historic objects are gone, because the flag describes
what is in the bucket rather than what the builder does.

`npm run report:purge -- <schoolId>` reports all of the above per school,
read-only. Against CAPSTONE ACADEMY on 2026-09-03: 97 rows, 2 files, 18 reads.

---

## 6. `assignedClasses` keeps a class after its last subject pair is removed

**Severity: medium. A teacher opens a class and the subject box is empty.**

Found from this side on 2026-09-13, when a tutor at Mt Cedar British
International School (`dV6zL3AEydAFJc3D3GrO`) could not pick a subject for
Nursery 1 when adding a lesson or a scheme of work.

The contract, in `docs/resultpeak-subject-allocation.md`: `assignedClasses` is
the **derived union of every class in `assignments`**. Production breaks it. Two
tutor profiles at that school hold a class that no pair in `assignments` names.
`subjectClasses` agrees with `assignments` in both, so the extra entry is in
`assignedClasses` alone:

| Tutor uid | Class held with no subject | `assignmentsUpdatedAt` |
|---|---|---|
| `3BV6nNf9rvVpA2olgI8D0farRjq1` | Nursery 1 (`wlCep9iEmYL9aZ96slVm`) | 2026-09-12T19:02:31Z |
| `meKwqrDX9eUt8qltyNkaC8ZszVc2` | SSS 1 (`ohWRsEorAi5GY0Fm7NZR`) | 2026-09-10T10:46:29Z |

Neither holds the class through `classTeacherOf` (both are `[]`). The likely
cause is an allocation save that merges the new classes into the stored
`assignedClasses` instead of recomputing it from `assignments`, so removing a
class's last pair never removes the class. Not confirmed from this side.

### The consequence

- **JDSmartLearn.** A picker narrowed to the tutor's pairs offered no subject for
  that class. The school has enforcement off, so every route would have accepted
  any subject; the empty box was a refusal nobody switched on.
- **ResultPeak.** The tutor keeps class-level access to a class the school has
  taken every subject away from. Under `subjectAllocation: true` that is a class
  they can see and author nothing in.

### Worked around on this side, 2026-09-13

`pickerAllocation()` in `src/lib/auth/subject-access.ts` treats a held class with
no usable pair as **unmatched**: every subject while enforcement is off (what the
routes accept), with a note saying why, and nothing, with a note naming the fix,
once it is on. That is a workaround for bad data, not the fix. The fix is
`docs/resultpeak-assigned-classes-prompt.md`.

`npm run diagnose:allocations -- [schoolId]` lists every case, read-only. Across
all four schools on 2026-09-13: the two rows above, nothing else.
