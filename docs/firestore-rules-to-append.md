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

match /topics/{topicId} {
  allow read: if isSignedIn()
              && request.auth.token.schoolId == resource.data.schoolId;
  allow write: if false;              // seeded/administered server-side only
}

match /lessons/{lessonId} {
  allow read: if isSignedIn()
              && request.auth.token.schoolId == resource.data.schoolId
              && (isSchoolAdmin(resource.data.schoolId)
                  || resource.data.tutorId == request.auth.uid);
  allow write: if false;              // Admin SDK only
}

match /generatedContent/{id} {
  allow read, write: if false;        // contains marking guides - server only
}

match /lessonViews/{id} {
  allow read: if isSchoolAdmin(resource.data.schoolId);
  allow write: if false;
}

match /studentLogins/{id} {
  allow read, write: if false;        // sign-in alias - Admin SDK only
}

match /jdAuditLogs/{id} {
  allow read: if isSchoolAdmin(resource.data.schoolId);
  allow create: if false;             // Admin SDK only
  allow update, delete: if false;     // append-only
}

// ---------- JDSmartLearn: assessment ----------
// Read these three notes before changing anything below.
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
//    that does not exist.
//
// 3. ALL WRITES ARE `false`. Same as every JD collection above. A client write
//    would skip the assignedClasses check, the due-date check, the score clamp
//    and the audit log, all of which live in the route handlers.

match /assignments/{assignmentId} {
  // Tutors read their own; admins read the whole school. Students: server only.
  allow read: if isSignedIn()
              && request.auth.token.schoolId == resource.data.schoolId
              && (isSchoolAdmin(resource.data.schoolId)
                  || resource.data.tutorId == request.auth.uid);
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
  allow read: if isSignedIn()
              && request.auth.token.schoolId == resource.data.schoolId
              && (isSchoolAdmin(resource.data.schoolId)
                  || resource.data.tutorId == request.auth.uid);
  // Scores are never client-written. aiScore, teacherScore and finalScore are
  // set by route handlers after the clamp to 0..maxMarks.
  allow write: if false;
}

match /studentProgress/{id} {
  // Admins only at this layer. A tutor rule would need classId on the document,
  // and a denormalized classId goes stale the moment a student changes class -
  // the same reason studentLogins deliberately has none. Tutors and students
  // both read progress through server routes that resolve the class live.
  allow read: if isSchoolAdmin(resource.data.schoolId);
  allow write: if false;              // Admin SDK only
}

match /jdNotifications/{id} {
  allow read: if isSignedIn()
              && request.auth.token.schoolId == resource.data.schoolId
              && (isSchoolAdmin(resource.data.schoolId)
                  || (resource.data.audience == 'tutor'
                      && resource.data.targetId == request.auth.uid));
  allow write: if false;              // Admin SDK only
}

// ---------- Shared with ResultPeak: owned by NEITHER platform ----------
// studentAcademicRecords/{schoolId}_{studentId}
//
// FIELD OWNERSHIP IS THE ENTIRE CONTRACT:
//
//   JDSmartLearn writes ONLY  continuousAssessment.{subjectId}.{assessmentTypeId},
//                             lastUpdatedByLMS
//   ResultPeak    writes ONLY  examScore.{subjectId},
//                             lastUpdatedByAssessment
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
  allow read: if isSchoolAdmin(resource.data.schoolId);
  allow write: if false;              // both platforms, Admin SDK only
}

match /jdSchoolSettings/{schoolId} {
  // The current term and session, and which assessment type the LMS feeds.
  // A stopgap: ResultPeak records none of these anywhere today.
  allow read: if isSignedIn() && request.auth.token.schoolId == schoolId;
  allow write: if false;              // Admin SDK only, school admins only
}

match /jdCaScores/{id} {
  // JDSmartLearn's own copy of every CA score it calculated, so the shared
  // document can be rebuilt if it is ever wiped from the other side.
  allow read: if isSchoolAdmin(resource.data.schoolId);
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
   check before it writes `examScore`, rejecting any key whose root is not
   `examScore` or `lastUpdatedByAssessment`, and it must write with `merge`.
   Until that guard exists, the contract is enforced on one side only, and a
   single `set()` without merge from ResultPeak wipes every school's continuous
   assessment. **Ship this guard in the ResultPeak repo before JDSmartLearn
   writes its first CA score.**
