# Firestore rules to append (DO NOT DEPLOY FROM THIS REPO)

`firestore.rules` is **project-level**. Deploying it from JDSmartLearn would
overwrite ResultPeak's rules and break a paying school's live exams.

**Process:** copy the block below into the canonical `firestore.rules` in the
**ResultPeak repo**, by pull request, and deploy from there. Test against the
Firebase emulator first.

```
// ---------- JDSmartLearn ----------
// No public read branch on anything here. Student-facing content is served
// through server routes using the Admin SDK, not direct client reads.
//
// ============================================================================
// A CLAIM COMPARISON ALONE IS NOT AN AUTHORIZATION CHECK. ACTIVE MUST BE
// CHECKED TOO.
//
// `request.auth.token.schoolId == resource.data.schoolId`, with or without a
// `tutorId == request.auth.uid` beside it, is TRUE FOR A DEACTIVATED TUTOR.
// Deactivation clears `active` on the custom claims; it does not delete the
// Firebase account, it does not change the token's `schoolId`, and it does not
// unstamp that person's uid from documents they created. So the two things the
// comparison tests both keep passing after the person is removed from the
// school.
//
// INCIDENT, 2026-08-12. ResultPeak's tests/firestore.rules.test.mjs caught this
// in the deployed rules and traced it back to this file, which is where the
// pattern was written. Every JDSmartLearn block used the bare comparison:
// topics and lessons, live for weeks, plus assignments, submissions and
// jdNotifications added with the assessment work. A tutor removed from a school
// kept reading every assignment they had ever set, MARKING GUIDES INCLUDED, and
// every submission and notification hanging off them. ResultPeak has fixed its
// deployed rules; this file is the fix at the source.
//
// THE FIX IS TO CALL THE HELPERS BY NAME. Never re-inline the comparison, not
// even "just for this one collection" - a copy of an inlined block is how this
// spread across five collections in the first place.
//
//   isActiveClaim()            active == true AND mustChangePassword != true
//   isTutor(schoolId)          isActiveClaim() + role 'tutor' + school match
//   isSchoolAdmin(schoolId)    superadmin, claims school admin, or legacy admin
//   isMember(schoolId)         isSchoolAdmin(schoolId) || isTutor(schoolId)
//
// All four exist in the canonical firestore.rules in the ResultPeak repo (the
// primitives block near the top of the file) and are verified against it as of
// 2026-08-12. Before adding a helper to a block here, confirm it exists THERE:
// this file is copied into that repo, and a call to a helper that does not
// exist fails to compile and blocks the whole deploy, taking the working rules
// with it.
//
// Every field read goes through `.get(field, default)`. A missing field is an
// ERROR in rules, not null, and an erroring rule denies. ResultPeak's file uses
// this form throughout; matching it here means the block can be copied across
// unchanged rather than translated by hand.
// ============================================================================

match /topics/{topicId} {
  allow read: if isMember(resource.data.get('schoolId', ''));
  allow write: if false;              // seeded/administered server-side only
}

match /lessons/{lessonId} {
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''))
              || (isTutor(resource.data.get('schoolId', ''))
                  && resource.data.get('tutorId', '') == request.auth.uid);
  allow write: if false;              // Admin SDK only
}

match /generatedContent/{id} {
  allow read, write: if false;        // contains marking guides - server only
}

match /lessonViews/{id} {
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''));
  allow write: if false;
}

match /studentLogins/{id} {
  allow read, write: if false;        // sign-in alias - Admin SDK only
}

match /jdAuditLogs/{id} {
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''));
  allow create: if false;             // Admin SDK only
  allow update, delete: if false;     // append-only
}

// ---------- JDSmartLearn: assessment ----------
// Read these four notes before changing anything below.
//
// 1. STUDENTS HAVE NO IDENTITY AT THIS LAYER. They sign in with school +
//    username + access code and carry a signed cookie, not a Firebase Auth
//    token, so `request.auth` is null for every student request. No rule here
//    can grant a student anything. Every student read is served by a route
//    handler using the Admin SDK, which checks the session, the schoolId and
//    the classId itself. These rules are the backstop against a stolen TUTOR
//    token, not the student authorization model.
//
// 2. FIRESTORE HAS NO FIELD-LEVEL READ SECURITY. A rule cannot hide
//    `markingGuide` from a reader allowed to read the document. The guide is
//    safe because no student can read the document at all, and because the
//    server projects through toStudentAssignment() before responding. Do not
//    add a rule that appears to hide a field; it would read as a guarantee
//    that does not exist. A school admin reading `assignments` here DOES see
//    marking guides, and that is the accepted cost of the admin branch.
//
// 3. ALL WRITES ARE `false`. Same as every JD collection above. A client write
//    would skip the assignedClasses check, the due-date check, the score clamp
//    and the audit log, all of which live in the route handlers.
//
// 4. TUTOR ACCESS GOES THROUGH isTutor(), NEVER A CLAIM COMPARISON. See the
//    2026-08-12 incident note at the top of this file. A marking guide is the
//    single most valuable thing a deactivated tutor could still read, and this
//    is the block that let them.

match /assignments/{assignmentId} {
  // Tutors read their own; admins read the whole school. Students: server only.
  // isTutor() folds in isActiveClaim(); a bare token.schoolId comparison would
  // stay true for a deactivated tutor and hand back the marking guide.
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''))
              || (isTutor(resource.data.get('schoolId', ''))
                  && resource.data.get('tutorId', '') == request.auth.uid);
  allow write: if false;              // Admin SDK only - carries a marking guide
}

// FLAT, not a subcollection of assignments. A student's list filters on
// schoolId AND studentId; as a collectionGroup query that would need a
// COLLECTION_GROUP composite index in this project's index file, and a
// deterministic id (`{assignmentId}_{studentId}`) makes the duplicate-submission
// check a single get. See docs/firestore-indexes-to-append.md.
match /submissions/{submissionId} {
  // tutorId is denormalized onto the submission precisely so this stays a field
  // comparison. A get() on the parent assignment would bill one read per
  // document the rule evaluates.
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''))
              || (isTutor(resource.data.get('schoolId', ''))
                  && resource.data.get('tutorId', '') == request.auth.uid);
  // Scores are never client-written. aiScore, teacherScore and finalScore are
  // set by route handlers after the clamp to 0..maxMarks.
  allow write: if false;
}

match /studentProgress/{id} {
  // Admins only at this layer. A tutor rule would need classId on the document,
  // and a denormalized classId goes stale the moment a student changes class -
  // the same reason studentLogins deliberately has none. Tutors and students
  // both read progress through server routes that resolve the class live.
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''));
  allow write: if false;              // Admin SDK only
}

match /jdNotifications/{id} {
  // A notification names an assignment and a class, so a deactivated tutor
  // reading their own backlog is still a leak. isTutor(), not a claim compare.
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''))
              || (isTutor(resource.data.get('schoolId', ''))
                  && resource.data.get('audience', '') == 'tutor'
                  && resource.data.get('targetId', '') == request.auth.uid);
  allow write: if false;              // Admin SDK only
}

// ---------- Shared with ResultPeak: owned by NEITHER platform ----------
// studentAcademicRecords/{schoolId}_{studentId}
//
// FIELD OWNERSHIP IS THE ENTIRE CONTRACT, AND EACH SIDE STATES ITS OWN HALF:
//
//   JDSmartLearn writes  continuousAssessment.{subjectId}.{assessmentTypeId},
//                        lastUpdatedByLMS
//                        AND NOTHING ELSE.
//
// Each guard is an ALLOWLIST of its own fields, never a denylist of the other
// side's. JDSmartLearn's assertRecordFields() names the two roots above and
// refuses every other root by default, at every depth, without knowing or
// caring which fields exist over here. ResultPeak's mirror guard should name
// only its own roots and refuse the rest the same way.
//
// This is not a style preference. A guard listing the OTHER platform's fields
// fails open: a field added on that side stays writable from the other until
// somebody remembers to extend the list. It also drifts silently, and it already
// had. The rules comment in this repo listed four ResultPeak-owned fields where
// JDSmartLearn's docs listed two, for weeks, and nothing caught it because
// nothing depended on either list being right. Both guards were unaffected
// precisely because neither reads the other's list.
//
// continuousAssessment is TWO levels deep and its values are PERCENTAGES, 0 to
// 100, never raw marks. The inner key is the assessment type's stable `value`
// from schools/{id}.assessmentTypes. ResultPeak owns each type's maxScore and
// scales the percentage on its side; JDSmartLearn never does that arithmetic.
//
// Both sides write with the Admin SDK, which bypasses these rules, so the real
// enforcement is assertRecordFields() in JDSmartLearn's lib/db/write-guard.ts.
// ResultPeak needs the mirror-image guard on its side before it writes here.
//
// Never set() this document without merge, from either side. A whole-document
// write from one platform silently destroys the other's marks, and there is no
// recovery path: the source data for continuous assessment lives in
// JDSmartLearn's submissions, and the source for exam scores lives in results.
match /studentAcademicRecords/{id} {
  // schoolId is stamped on every write by BOTH guards precisely so this rule
  // has a field to read. Without the default, a document created without it
  // would be permanently unreadable by its own school admin.
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''));
  allow write: if false;              // both platforms, Admin SDK only
}

match /jdSchoolSettings/{schoolId} {
  // The current term and session, and which assessment type the LMS feeds.
  // A stopgap: ResultPeak records none of these anywhere today.
  //
  // isMember(), not a claim comparison. Tutors read this (the skip surface on
  // the tutor page tells them when the assessment type is unset), so the rule
  // needs a tutor branch - and a tutor branch written as a claim compare is
  // exactly the 2026-08-12 bug. isMember() is isSchoolAdmin() || isTutor(),
  // and both fold in isActiveClaim().
  allow read: if isMember(schoolId);
  allow write: if false;              // Admin SDK only, school admins only
}

match /jdCaScores/{id} {
  // JDSmartLearn's own copy of every CA score it calculated, so the shared
  // document can be rebuilt if it is ever wiped from the other side.
  allow read: if isSchoolAdmin(resource.data.get('schoolId', ''));
  allow write: if false;              // Admin SDK only
}
```

## BLOCKING: the fold into `manualScores` must be idempotent

**Read this before writing a single line of the fold.** It is the highest-risk
part of the whole integration and it fails silently.

`manualScores` scores are **summed, not replaced**. In
`src/lib/termResultData.js`:

```js
const manualTotal = matchingManualScores
  .filter(...)
  .reduce((sum, score) => sum + Number(score.score || 0), 0);
const finalScore = Math.min(maxScore, automatedScore + manualTotal);
```

and every manual score today is written with `addDoc`, which mints a **random
id**, so a repeat write adds a second row rather than replacing the first.
ResultPeak has already been bitten by this: `ResultsDashboardPage.jsx` carries a
comment recording a live incident where a double-click wrote a score twice and
inflated a student's subject total.

### What goes wrong, worked through

A tutor releases coursework worth 8 out of 10 for one child. The fold writes a
`manualScores` row with `score: 8`. A week later the tutor corrects another mark
in the same subject, JDSmartLearn recalculates the CA, and the fold runs again.

- With `addDoc`: a **second** row of `score: 8` now exists. `manualTotal` becomes
  16. `finalScore` is `Math.min(10, 16)` which is **10**. The child now shows
  full marks for coursework they scored 80 percent on.
- Nothing errors. Nothing logs. The result sheet renders normally.
- It happens to **every student in the class at once**, because a resync is a
  batch operation, and the inflation is clamped to the maximum so the numbers
  still look plausible.
- It is not recoverable by inspection later: once two identical rows exist there
  is no way to tell a genuine second manual score from a duplicate.

### The requirements

1. The fold **MUST be idempotent.** Running it twice must leave exactly the same
   data as running it once.
2. It **MUST use a deterministic document id** for any LMS-sourced score, built
   from the same parts as `getManualScoreKey` plus the subject, the assessment
   type, and a marker identifying it as LMS-sourced:

   ```
   lms__{studentId}__{schoolId}__{classId}__{academicSession}__{term}__{subjectId}__{assessmentType}
   ```

3. It **MUST write with `setDoc(..., { merge: true })`**, so a resync overwrites.
4. It **MUST NEVER use `addDoc`** for an LMS-sourced score.
5. It should stamp a `source: "jdsmartlearn"` field, so LMS-sourced rows can be
   told apart from ones an operator typed and can be recalculated in bulk.
6. It scales the percentage: `Math.round(percentage / 100 * type.maxScore)`,
   using the type's own `maxScore` from `schools/{id}.assessmentTypes`.
   JDSmartLearn deliberately does not do this, because a max it cached could be
   edited on the school document an hour later.

JDSmartLearn already holds itself to this on its own side: `jdCaScores` uses a
deterministic id and `set` with merge, for exactly this reason.

## Separately: two ResultPeak fixes this product depends on

1. **`students` public read.** Any doc with `isActive == true` is currently
   world-readable, exposing minors' names, admission numbers, and classes.
   Replace the un-authed registration dropdown with a server lookup endpoint,
   then set that branch to `false`. Do this before JDSmartLearn adds more
   student-linked data to the project.

2. **Topic tagging.** Add optional `topicId` to `exams/{examId}/questions/{qid}`
   and stamp it into each entry of `results.answers[]` at submission.
   Without it, topic-level revision recommendations are impossible, and
   untagged results can never be back-filled. Cheapest to do now, while there
   is almost no historical data.

3. **The mirror guard on `studentAcademicRecords`.** JDSmartLearn enforces its
   half of the contract in `assertRecordFields()`. ResultPeak needs the same
   check before it writes `examScore`, and it must write with `merge`. Until that
   guard exists, the contract is enforced on one side only, and a single `set()`
   without merge from ResultPeak wipes every school's continuous assessment.
   **Ship this guard in the ResultPeak repo before JDSmartLearn writes its first
   CA score.**

   Write it as an **allowlist of ResultPeak's own field roots**, refusing
   everything else by default at every depth, not as a denylist of
   JDSmartLearn's. JDSmartLearn's guard is built that way and names only
   `continuousAssessment` and `lastUpdatedByLMS`. Two allowlists that each know
   only their own half cannot drift apart; two denylists inevitably do.

4. **Confirm whether `combinedScore` and `grade` are still stored at all.**
   ResultPeak's `firestore.rules` comment on `studentAcademicRecords` lists four
   owned fields, `examScore`, `combinedScore`, `grade` and
   `lastUpdatedByAssessment`, where every JDSmartLearn document lists two.

   The likely explanation is that `combinedScore` and `grade` are leftovers from
   the scrapped `schoolResultSettings` weighting plan and are now derived at
   sheet-build time rather than stored. **This needs confirming on that side, and
   if they are no longer written, the two stale names should come out of the
   comment.** A comment naming fields nobody writes is what made the two repos
   look like they disagreed about the contract when they did not.

   Nothing in JDSmartLearn acts on this either way: its guard never reads
   ResultPeak's list, which is exactly why the drift cost nothing. Do not "fix"
   it by adding those names anywhere in this repo.
