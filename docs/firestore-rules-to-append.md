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

match /jdAuditLogs/{id} {
  allow read: if isSchoolAdmin(resource.data.schoolId);
  allow create: if false;             // Admin SDK only
  allow update, delete: if false;     // append-only
}
```

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
