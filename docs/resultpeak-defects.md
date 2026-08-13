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
