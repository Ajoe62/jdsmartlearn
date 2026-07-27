# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It asks ResultPeak to own student usernames so one
login works in both products, and — the priority — to make school onboarding
produce working logins for every student without anyone having to remember a
follow-up step.

After it ships, JDSmartLearn has a small follow-up: switch `resolveUsername` in
`src/lib/db/student-logins.ts` from a `studentLogins` document get to a
`studentAccess` query on `(schoolId, username)`, and retire the `studentLogins`
collection, the assign script, and the "Create usernames" button. Until then
both work — JDSmartLearn keeps resolving its own aliases.


---

## Context

You are working in **ResultPeak**, a school exam/results platform, live on
Firebase project `resultpilot-ddf7c` (Spark plan).

A sibling product, **JDSmartLearn** (an LMS), runs inside the *same* Firebase
project — same `projectId`, same Auth directory, same Firestore database. It
reads ResultPeak's collections and never writes to them.

**New schools are being onboarded starting next week.** Each one will create
classes, load a roster, hand out logins, and expect every child to be able to
sign in to both products the same day. Today that does not happen: at the one
school already loaded, **only 30 of 76 active students can sign in at all**,
because student records and login credentials are created by two different paths
and one of them never issues a credential.

**This task is about the path forward, not the backlog.** The deliverable is an
onboarding flow where a school cannot end up in a broken state — where "student
exists but cannot log in" is unreachable by construction. Repairing the existing
school is the last task on the list, and it should fall out of the same code.

Students also currently sign in with a **20-character Firestore document id**
plus a 6-character access code. A Primary 3 pupil on a mid-range Android phone
cannot type or remember `1UCH1yivCmB8fyapxWlC`. Students will sign in with a
short **username** (`jss3-04`) instead. JDSmartLearn already mints these into its
own `studentLogins` alias collection; that was the wrong home. The username is a
**credential identifier**, and the credential — `studentAccess` — is ResultPeak's.
ResultPeak becomes the single owner of both, issuing them together.

## Hard constraints

- A paying school is running live exams in this project. Nothing here may change
  exam behaviour, and no migration may run without a dry-run mode.
- **Never change an existing access code**, and never change a student's document
  id. Thirty students are already signed in to JDSmartLearn with theirs.
- Every Firestore query filters by `schoolId` and carries an explicit `.limit()`
  — the Spark quota is shared with JDSmartLearn.

---

# The invariants

Everything below exists to hold these true. Enforce them in code, not in a
runbook. Each one should be impossible to violate through the UI, the import,
or the API.

1. **Every active student has a `studentAccess` document.** Created in the same
   write as the student record, never as a follow-up action. A student without
   one is a child who cannot log in.
2. **Every `studentAccess` document carries `code`, `username`, and `schoolId`.**
   All three, always. JDSmartLearn scopes sign-in on `schoolId` and fails closed
   without it.
3. **A username is unique within a school and permanent.** It survives a class
   change, a rename, and a re-import. Re-issuing one locks a child out.
4. **Every school has a unique `slug`.** Two schools may not share a name or a
   slug — a child faced with two identical rows in a picker can never sign in.
5. **Every class name within a school is unique after normalisation.** `SS 1`
   and `SS1` are the same class; usernames derive from the class name, so
   near-duplicates silently split a cohort.
6. **There is exactly one path that creates a student.** Single-add, CSV import,
   and any API route all funnel through it. Two paths is how the current gap
   happened.

---

# Task 1 (P0) — One student-creation path

Find every place a `students` document is created today. There are at least two:
a roster import that sets `admissionNumber` and never issues a code, and an
exam-registration path that issues a code and never sets `admissionNumber`. At
the loaded school these two sets are **perfectly disjoint** across all six
classes — a precise fingerprint of the split.

Collapse them into a single `createStudent` service that, in **one batched
write**, creates:

- the `students` document (`fullName`, `admissionNumber`, `classId`, `className`,
  `schoolId`, `isActive`), and
- the `studentAccess` document (`code`, `username`, `schoolId`).

Batched, so a partial failure cannot produce a student without a login. Every
caller — UI, import, API — goes through it. Delete the other paths; do not leave
one behind "for admin use".

Reuse ResultPeak's existing access-code generator. Do not invent a new alphabet:
the current codes deliberately avoid ambiguous characters (`UU3TMK`, `6U53PF`,
`QE33X3`, `V758BE`) and children read them off paper.

## Task 2 (P0) — Usernames, issued with the code

Add `username` to `studentAccess`, minted in the same write as the code.

**Format:** `{class-slug}-{NN}` — `jss3-04`, `jss1-11`, `ss2-14`.

```
classSlug("JSS 3")             -> "jss3"
classSlug("Primary 4 (Gold)")  -> "primary4-gold"
```

Lowercase; collapse every run of non-alphanumeric characters to `-`; join a
level word to its number (`jss-3` → `jss3`); trim leading and trailing hyphens.
The number is 1-based in roster order, zero-padded to two digits.

Rules that matter more than the format:

- **Unique per school, not per class.** If a candidate is taken, increment.
  Enforce it with a transaction or a uniqueness document — two admins importing
  at once must not collide.
- **The prefix is captured at issue time and frozen.** Renaming a class later
  must not change anyone's username.
- **Never renumber.** A student moved between classes keeps `jss2-07` even in
  JSS 3. It is a credential, not a label.
- A student re-imported (same name, same class) must resolve to the existing
  record and keep their existing username and code.

**Index note:** JDSmartLearn resolves a username with
`where("schoolId","==",…).where("username","==",…).limit(1)`. Two equality
filters need no composite index, so nothing new has to be deployed — but make
sure `username` is not added to any `fieldOverrides` that disables indexing.

## Task 3 (P0) — The onboarding flow, end to end

This is what a new school does next week. Walk it as a user, then make it work
without a single manual repair step.

**Step 1 — Create the school.** Require a **unique `slug`** at creation,
validated against existing schools, suggested from the name and editable. Reject
a duplicate name outright, or force the slug to differ and make the difference
visible in every picker. The slug is the school's permanent sign-in address
(`/s/capstone-academy`), so it must be stable and typeable.

**Step 2 — Create classes.** Normalise the name on write (trim, collapse inner
whitespace, consistent casing) and reject a near-duplicate within the school:
`SS 1` when `SS1` exists must fail with a message naming the existing class.
Usernames derive from these names, so a near-duplicate splits a cohort in half.
Classes must exist before students — the class is what names the username.

**Step 3 — Load the roster.** CSV import is the realistic bulk path. It must:

- issue code + username inline for every row, through the Task 1 service;
- **detect duplicates before writing**, not after — match on normalised name
  within the class and show the operator what will be created, updated, and
  skipped, with a confirm step;
- be idempotent, so re-uploading a corrected file updates rather than doubles;
- report per-row failures without aborting the successful rows;
- never overwrite an existing code or username.

**Step 4 — Hand out logins.** A printable sheet per class: student name,
username, access code. Codes hidden behind a "Show codes" toggle — an admin may
be holding a phone in front of a room. This is the artefact the school actually
uses on day one; make it print cleanly on A4.

**Step 5 — Readiness check.** Before a school is marked live, show a check that
must be green: every active student has a code and a username, no duplicate
class names, slug unique, every class has at least one student. Surface it on
the school's admin dashboard permanently, not just once, so a regression is
visible the day it happens. If any invariant above can still be violated, this
check is where it will show up — treat a red check as a bug in Tasks 1–2, not
as a chore for the admin.

## Task 4 (P0) — Sign-in accepts the username

Update ResultPeak's student sign-in (the exam-entry path) to accept
**school + username + code**, resolving the username to a student id server-side.

- Keep accepting the raw student document id as a silent fallback. Both are in
  circulation, and JDSmartLearn does the same.
- Do not reveal which half was wrong; one vague message for every failure.
- Throttle by identifier *and* by caller IP.
- A username from another school must be rejected even with a valid code —
  assert the resolved student's `schoolId` matches the school that was selected.

## Task 5 (P1) — Rules

`firestore.rules` is project-level and lives in **this** repo — JDSmartLearn is
forbidden from deploying it. Before new schools load real rosters:

- `students` currently has a public read branch: any doc with `isActive == true`
  is world-readable, exposing minors' names, admission numbers and classes.
  Replace the un-authed registration dropdown with a server lookup endpoint,
  then set that branch to `false`. Every new school multiplies this exposure.
- `studentAccess` must stay server-only. Adding `username` to it must not open
  any client read path — a readable `studentAccess` hands out every code in the
  school.
- JDSmartLearn maintains `docs/firestore-rules-to-append.md` in its own repo with
  the `match` blocks for its collections. Pull them in by PR; all deny-all
  except `topics` and `lessons`.

## Task 6 (P2) — Repair the school already loaded

Once the flow above is right, this is one idempotent script with a dry-run mode,
not a project. It should reuse the Task 1 service rather than reimplementing it.

At **CAPSTONE ACADEMY** (`schoolId: U9SJpzzKUtF6S9V8cG7D`), of 76 active students
across six classes, 46 have no `studentAccess` document.

- **Import JDSmartLearn's existing usernames before generating any.** Thirty
  students are already using them and must not be renamed:

  ```
  Collection: studentLogins
  Doc id:     `${schoolId}_${username}`     e.g. U9SJpzzKUtF6S9V8cG7D_jss3-04
  Fields:     { schoolId, studentId, username, createdAt }
  ```

  All 30 are at CAPSTONE: `jss1-01`…`jss1-05`, `jss2-01`…`jss2-03`,
  `jss3-01`…`jss3-08`, `ss2-01`…`ss2-14`. Read the collection once for the
  import, then leave it alone — JDSmartLearn will retire it.

- **Duplicate students.** The same child exists twice, once per creation path.
  Report them for admin review; **do not auto-merge** — results, exam sessions
  and scores hang off these ids.

  | Roster record | Exam record |
  |---|---|
  | Love Ogiamien (`tm9FqeBtbhfKg7J6IOHO`) | Love Ogiamen (`s7Rc5pXCzMuxWNAIEQE8`) |
  | Princess Momoh (`QlVQokGrRJpqy0McS7ix`) | Momoh Princess (`bHYNWow05j8k3fqOCGKU`) |
  | Isabella Isaac (`9rUkwAZwRtvDWzwSOjpa`) | Isaac Isabella (`HcHoMt6UzEiYDRmtTgaH`) |
  | Obazuaye Christopher (`1UCH1yivCmB8fyapxWlC`) | Obazuaye Christopher (`ckyXi7zV1O7HIuwxMmWf`) |

  Do not issue a code to a record an admin has marked duplicate — otherwise one
  child ends up with two logins.

- **Duplicate schools.** Two pairs share a name, which is exactly what Task 3
  Step 1 prevents going forward. Decide whether each pair is one school or two;
  deactivate dead ones (`isActive: false`, never delete — results reference them);
  assign slugs to the survivors.

  - **Brighter Star** — `41VpdeJO2beZo85FSxGA`, `TXYIr839YWVq4zZqdS86`
  - **YpnConnect** — `oCd1vjwF684btvgxX5eT`, `ypnconnect`

- **Duplicate classes.** CAPSTONE has `SS 1` (empty) and `SS1`. Deactivate the
  empty one.

---

## Definition of done

Judge this on a school that does not exist yet.

- [ ] Creating a school, three classes, and a 40-row CSV produces 40 students who can all sign in, with **no** manual step in between
- [ ] Re-uploading the same CSV changes nothing and duplicates nothing
- [ ] A near-duplicate class name is rejected at creation with a useful message
- [ ] A duplicate school name or slug is rejected at creation
- [ ] Moving a student to another class leaves their username and code unchanged
- [ ] The readiness check is green for the new school and stays green after each of the above
- [ ] There is exactly one code path that creates a student — grep proves it
- [ ] Student sign-in accepts school + username + code, raw id as fallback; another school's username is rejected even with a valid code
- [ ] `students` no longer world-readable; `studentAccess` still server-only
- [ ] CAPSTONE repaired: 46 codes issued, 0 existing codes changed, all 30 imported usernames intact
- [ ] Every migration dry-runs by default and is idempotent on a second run

## Verification

1. **Onboard a fake school end to end** — school, classes, CSV, print sheet,
   sign in as a student from the sheet. This is the real test; do it first.
2. Re-run the import with one corrected row. Confirm one update, no new records.
3. Rename a class. Confirm no username changed.
4. Then, on CAPSTONE (`U9SJpzzKUtF6S9V8cG7D`): dry-run the repair, expect ~46 new
   `studentAccess` docs and 0 changed codes; confirm `jss3-01` still resolves to
   `CVHOqzediPBQm3ueKRPD` (Aifuwa Daniel uhnoma) and `jss3-04` to Faith Ufumwen.
5. Sign in to ResultPeak as `jss3-01` + that student's code, then sign in to
   JDSmartLearn at `/student/sign-in` with the **same two values**.
