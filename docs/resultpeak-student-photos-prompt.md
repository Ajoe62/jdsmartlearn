# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository.

**Status (2026-09-28): SHIPPED on both sides.** ResultPeak shipped Tasks 0-7,
named the deep link `/start/student?next=photo`, and added a third collection,
`studentPhotoState` (upload counts, rejection reasons), which JDSmartLearn's
write guard and purge report now name beside the other two. JDSmartLearn then
shipped the display side: `/api/student/photo`, the dashboard photo card, the
link out, and the offline copy. The text below is the brief as sent.

**Status when sent: decided, guarded, nothing
built.** JDSmartLearn has named `studentPhotos` and `studentPhotoSubmissions` as
ResultPeak-owned collections that its write guard refuses, before either exists.
It has built no upload, no storage and no display. **ResultPeak ships first.**
JDSmartLearn's display work (a protected photo route, the dashboard header, a
link to your upload screen) waits until Task 1 below is live. It is safe in
either order, because JDSmartLearn treats a missing photo as a normal state.

Owner decisions this prompt is built on, all made 2026-09-28:

1. Students get a passport photograph stored against their profile. This is a
   deliberate exception to JDSmartLearn's "collect nothing new about students"
   rule, and it is why the rules below are strict.
2. **The school approves every photo a student submits.** No auto-approve.
3. The photo appears on the student's **exam dashboard** and on **printed result
   sheets and report cards**.
4. **How long a photo is kept after a student leaves or graduates is NOT
   decided.** Build no timer, no expiry and no retention job. Deletion happens
   with the student and with the school, nothing more, until the owner decides.

---

## Context

You are working in **ResultPeak**, a school exam and results platform, live on
Firebase project `resultpilot-ddf7c` (Blaze plan since 2026-09-03, for scheduled
backups), with paying schools running real exams on it.

A sibling product, **JDSmartLearn** (an LMS for the same schools), runs inside
the *same* Firebase project: same `projectId`, same Auth directory, same
Firestore database. Both are Ilumotech products. ResultPeak owns the roster —
`schools`, `classes`, `students`, `studentAccess`, `studentUsernames`, the tutor
and admin subcollections — and JDSmartLearn reads those and never writes them.

Students are Pre-nursery to SS3, signing in with school + username + access code
on shared mid-range Android phones over slow, intermittent 3G. Teachers are not
technical.

The owner wants a **rectangular passport photograph** of each student, stored
against the student's profile and shown on both products. **It is ResultPeak's
data**, for the same reason the username and the crest became ResultPeak's: it
is part of the school's record of the child, and every time the two products
each kept their own copy of something like this, they drifted. The lesson from
usernames was concrete — a child ended up holding two different usernames, one
from the school office and one from their tutor. **There is to be exactly one
photo upload, and it is here.** JDSmartLearn will link to it.

## Hard constraints

- **Paying schools are running live exams.** Nothing here may change exam
  behaviour, scoring, result computation, or any existing query. A student with
  no photo must see exactly what they see today, plus a neutral placeholder.
- **`students/{id}` is a live document read by both products.** Adding one
  optional field is fine. Renaming, reshaping or removing anything is not.
  `fullName`, `admissionNumber`, `classId`, `className`, `schoolId`, `isActive`
  keep their names, types and meanings.
- **Every new field is optional and absent-safe.** No migration can be assumed
  to have run. Absent means "no photo", never an error.
- **Blaze bills an unbounded query silently.** Every query filters by `schoolId`
  and carries an explicit `.limit()`. A class list or a result-sheet print must
  never pull photo bytes it is not about to draw.
- **No photo bytes in any AI call**, from either product. No face detection
  through an AI provider. A human approves the photo.
- **Never a public URL to a child's photo.** Not a public bucket object, not a
  public Firestore read, not a guessable route. JDSmartLearn's school-crest route
  is unauthenticated because a crest is on the school gate; a child's face is
  not, and must never share that exception.
- **No migration runs without a dry-run mode**, including any bulk import.

---

# The invariants

Enforce these in code, not in a runbook.

1. **Only an approved photo is ever shown**, on any screen, printout or API
   response, in either product. A pending photo is visible only to the student
   who submitted it (as "Waiting for approval") and to the staff who can approve
   it.
2. **An approved photo and a pending photo never share a document.** The record
   JDSmartLearn reads contains approved bytes and nothing else, so a mistake over
   there cannot serve an unapproved image, because it is not in the document.
3. **There is exactly one write path** for each collection, one service called by
   every upload surface — staff single, staff bulk, student. Grep proves it.
4. **Every stored photo was re-encoded server-side.** Nothing stores the bytes a
   phone sent. Re-encoding strips EXIF, and **EXIF on a phone photo carries GPS
   coordinates — for a child that can be their home.** It also normalises format
   and size, and it defeats a file that only claims to be an image.
5. **Deleted with the child.** Removing a student deletes both documents.
   A rejected submission, and the previous photo when one is replaced, are
   deleted, not archived.
6. **Authorization is server-side on every request.** A student reads only their
   own photo and their own pending submission. A tutor only students in their
   classes. A school admin only their own school.

---

## Task 0 — Confirm the storage choice before writing code

**Recommendation: Firestore documents holding a small re-encoded JPEG as a data
URI, in two new flat collections.** Reasons, in order of weight:

- **One deletion path.** A photo in Firestore is deleted by the same cascade that
  deletes the student. A second storage backend is the sweep somebody forgets,
  and forgetting it here means a child's face outlives their record.
- **It fits, with room.** 350×450 at JPEG quality ~0.8 is 25–45 KB; as base64,
  under ~60 KB. The 1 MiB document limit is nowhere near.
- **It is the crest precedent.** `schoolBranding` already carries a data URI that
  JDSmartLearn decodes server-side and serves as bytes. Both products already
  have the code shape for this.
- **Separate documents keep the roster cheap.** Photos must NOT go on
  `students/{id}`: every class list, roster screen and result sheet reads those
  documents, and 40 × 60 KB on every class load is slow on 3G and billed on Blaze.

If you conclude otherwise — for instance, Firebase Storage because ResultPeak
already uses it — **say so in the reply with the reason**, keep invariants 1–6,
and keep the pointer field in Task 1 unchanged, because that is the part
JDSmartLearn reads. Do not serve photos from a public or long-lived URL in any
design.

---

## Task 1 (P0) — Storage and the one write service

### Collections

```
studentPhotos/{studentId}                  // APPROVED photo only
  schoolId:        string                  // tenant spine, always present
  studentId:       string
  classId:         string                  // denormalised for tutor authorization
  dataUri:         string                  // "data:image/jpeg;base64,..." <= ~60 KB
  width:           350
  height:          450
  bytes:           number                  // decoded size, for monitoring
  source:          "staff" | "student"     // who uploaded it
  uploadedBy:      string                  // uid of uploader (staff) or studentId
  approvedBy:      string                  // uid of approving staff member
  approvedAt:      Timestamp
  photoUpdatedAt:  Timestamp               // == approvedAt; mirrors the pointer

studentPhotoSubmissions/{studentId}        // at most ONE pending per student
  schoolId, studentId, classId
  dataUri, width, height, bytes            // same encoding as above
  submittedAt:     Timestamp
  status:          "pending"               // rejected/approved submissions are DELETED
```

A new submission from the same student overwrites the pending one. That bounds
the queue at one document per student forever.

### The pointer on the student

```
students/{studentId}.photoUpdatedAt?: Timestamp   // optional; absent = no photo
```

**This one field is the contract with JDSmartLearn.** JDSmartLearn already reads
`students/{id}` on every student sign-in and reconnect. It uses `photoUpdatedAt`
to decide whether there is a photo and to version the image URL, so a new photo
busts every cache and an unchanged one costs nothing. It must move **only** when
the approved bytes change: set it in the same batched write that writes
`studentPhotos/{id}`, and delete it in the same batch that deletes the photo.

### The service

One function, e.g. `api/_lib/photos/studentPhoto.js`, with exactly these entry
points and no others that write either collection:

- `submitStudentPhoto(studentId, bytes)` — student path. Validates, re-encodes,
  writes `studentPhotoSubmissions`. Changes nothing visible.
- `approveSubmission(studentId, approverUid)` — **one batch**: copy to
  `studentPhotos`, set `students.photoUpdatedAt`, delete the submission.
- `rejectSubmission(studentId, approverUid, reason)` — deletes the submission.
  Store the short reason where the student will see it next (e.g. a small field
  or your existing notification path), never the image.
- `setStudentPhotoByStaff(studentId, bytes, staffUid)` — staff path. Validates,
  re-encodes, and writes the approved photo directly: **a staff upload is the
  approval.** Also deletes any pending submission for that student.
- `removeStudentPhoto(studentId, staffUid)` — deletes the photo and the pointer.

### Server-side validation and re-encoding (all four upload paths)

- Accept JPEG, PNG, WebP, and HEIC if your image library supports it (iPhones and
  some Androids produce it). Check **magic bytes**, never the filename or the
  declared content type.
- Refuse input over **5 MB** before decoding.
- Decode, apply EXIF orientation, **crop to 7:9** (35×45 mm passport ratio) if the
  client did not, resize to **350×450**, re-encode as **JPEG, no metadata**.
  `sharp` does all of this in one pipeline (`.rotate().resize(350, 450, { fit:
  "cover" }).jpeg({ quality: 80, mozjpeg: true })`, which drops metadata by
  default).
- Refuse the result if it exceeds 80 KB after encoding (lower the quality once,
  then refuse).
- Refuse anything smaller than 200×257 source pixels: it will print as a smear
  on a report card.
- Rate limit student submissions: **3 per student per day.**
- Every write carries `schoolId` from the **caller's verified token / session**,
  never from the request body, and checks the student belongs to that school.

---

## Task 2 (P0) — The capture screen (one component, all three uploaders)

A shared component used by staff single upload and by the student:

- "Take photo" (opens the camera) and "Choose photo".
- A **fixed 7:9 rectangular crop frame** with a head-and-shoulders outline guide.
  Pinch to zoom, drag to position. The output is always the passport rectangle,
  never a square and never a circle.
- Short plain guidance beside it: *plain light background, face the camera, no
  cap or sunglasses, whole face showing.*
- **Shrink on the phone before upload** (canvas → JPEG ~350×450, quality 0.85).
  This keeps the upload to ~40 KB on 3G and already drops EXIF. The server still
  re-encodes (invariant 4), because a client is never trusted.
- Works at **360 px width**, and works with the camera permission denied (falls
  back to choosing a file).
- For a student: after upload, show **"Sent to your school for approval"** and,
  on the profile, the pending image labelled **"Waiting for approval"** beside
  the current approved photo (or placeholder). Show a rejection reason plainly,
  with "Try again".
- A consent line on the student and staff upload screens, e.g. *"This photo is
  kept by your school for exams and report cards."* The school is the data
  controller under the Nigeria Data Protection Act 2023; the wording is theirs to
  adjust, the line must be there.

**Deep link for JDSmartLearn.** JDSmartLearn's student dashboard will show "Add
or change photo" linking to this screen. Provide a stable path that follows the
existing student-link convention in `docs/resultpeak-cross-link.md` on the
JDSmartLearn side — for example `/start/student?next=photo` — and send the child
to the upload screen after sign-in. Tell JDSmartLearn the exact path in your
reply.

---

## Task 3 (P0) — Approval queue

- Visible to **school admins** (whole school) and **class teachers**
  (`classTeacherOf`, their class only). If a school has not set class teachers,
  admins only.
- A list of pending submissions, **newest first, `.limit(50)` per page**, each
  showing the **current approved photo and the submitted one side by side** with
  the student's name, class and admission number. That comparison is the whole
  job: is this the same child, and is it a proper passport photo?
- Approve, and Reject with a reason from a short list (*not a passport photo,
  face not clear, not this student, other*).
- A count badge on the admin dashboard so the queue is not forgotten.
- This query needs a composite index on `(schoolId, classId, submittedAt)` and
  one on `(schoolId, submittedAt)`. They go in **your** `firestore.indexes.json`,
  deployed from this repo.

---

## Task 4 (P0) — Staff upload: single and bulk

- **Single:** on the student's profile, the Task 2 component. Approved on save.
- **Bulk:** schools often have a photographer day, so this is the realistic main
  path. An admin uploads many image files (or one zip) **named by admission
  number or by username** (`ADM-0231.jpg`, `jss3-04.jpg`).
  - **Dry run first:** show matched, unmatched, and would-replace-existing, with
    thumbnails. Nothing is written until the admin confirms.
  - Bulk images are auto-cropped to 7:9 around the centre; show every crop in the
    preview so a bad one can be fixed singly.
  - Idempotent: the same file set twice changes nothing the second time.
  - Per-file failures are reported without aborting the rest.

---

## Task 5 (P0) — Display: exam dashboard, result sheets, report cards

- **Student exam dashboard:** the approved photo in the profile area, 7:9, with a
  neutral silhouette placeholder when absent. Never a broken-image icon and never
  a blank box.
- **Invigilator or exam supervision screens**, if any list students sitting an
  exam: the photo beside each name. This is the identity check the feature
  exists for.
- **Printed result sheets and report cards:** the photo in a fixed passport-size
  frame, in the header block, **35×45 mm at print scale**. With no photo, print
  the same frame empty with a thin border, so the layout never shifts and a
  school can paste in a physical photo. Test on A4, and on whatever PDF/print
  path you already use: embedded images are where print pipelines break.
- A class print of 40 report cards reads 40 photo documents, bounded by the
  roster query you already run. Do not read photos for students not being
  printed.
- **Serve photos to the browser through an authenticated route**, bytes decoded
  server-side from the data URI, `Content-Type: image/jpeg` from a fixed value
  (never from the stored string), `Cache-Control: private, max-age=31536000,
  immutable` with the URL versioned by `photoUpdatedAt`, plus `X-Content-Type-Options:
  nosniff`. Do not inline data URIs into list payloads.

---

## Task 6 (P0) — Deletion

- **Removing or purging a student** deletes `studentPhotos/{id}`,
  `studentPhotoSubmissions/{id}`, and the pointer, in the same operation that
  removes the student.
- **The school purge cascade** gains both collections as named stages. The
  protocol in JDSmartLearn's `docs/resultpeak-deletion-protocol-prompt.md` already
  lists `studentPhotos` in its report as "ResultPeak's, and must be a stage of its
  cascade"; add `studentPhotoSubmissions` beside it.
- **Deactivating** a student (not deleting) keeps the photo but stops serving it:
  the serve route 404s for an inactive student in both products.
- **Retention after leaving or graduating: not decided.** Build nothing for it.
  Leave a comment at the deletion service pointing at this decision so whoever
  builds it later lands in the right place.
- Be explicit in the reply about **backups**: your scheduled backups will contain
  photos. Say how long backups are kept, because that is how long a deleted photo
  still exists somewhere, and the school's data policy should say so.

---

## Task 7 (P0) — Rules

`firestore.rules` is project-level and lives in this repo. JDSmartLearn never
deploys it. Both new collections are **server-only**:

```
match /studentPhotos/{studentId} {
  allow read, write: if false;   // served through authenticated routes only
}
match /studentPhotoSubmissions/{studentId} {
  allow read, write: if false;   // written and read only by the photo service
}
```

If your client genuinely needs a direct read for a screen, write it with your
existing helpers (`isActiveClaim()`, `isSchoolAdmin()`, `isTutor()`), checking
active status, `schoolId` and class, and **never** a public branch. Server-only
is strongly preferred: a rule that lets a signed-in student `get` another
student's photo by id is the failure to avoid, and ids appear in URLs.

`students/{id}.photoUpdatedAt` reveals nothing and needs no rule change. Note
that JDSmartLearn's earlier shared-login prompt asked for the `students` public
read branch to be closed; if it is still open, closing it matters more once a
photo exists to point at.

---

## Definition of done

- [ ] A student uploads a photo on a 360 px phone over throttled 3G; it arrives under 60 KB and shows "Waiting for approval"
- [ ] Nothing about that photo is visible to anyone else, on any screen or print, until approved
- [ ] The class teacher approves it; it appears on the exam dashboard and on the next report card print, and `students.photoUpdatedAt` moved in the same batch
- [ ] A rejected photo is gone from Firestore, and the student sees the reason
- [ ] An admin bulk-uploads 40 files by admission number: dry run first, idempotent on re-run
- [ ] The stored JPEG has no EXIF/GPS (check with `exiftool`), is 350×450, and was re-encoded server-side
- [ ] A student cannot load another student's photo by changing an id in a URL
- [ ] Deleting a student deletes the photo, the submission and the pointer; the school purge sweeps both collections
- [ ] A student with no photo sees a placeholder on the dashboard and an empty passport frame on the report card — no layout shift, no broken image
- [ ] No existing exam, result, or roster query changed; grep proves one write path per collection
- [ ] No photo bytes appear in any AI request

## What JDSmartLearn does after this ships

1. A protected route (`/api/student/photo`) that reads `studentPhotos/{id}` for
   the **signed-in student only**, checks `isActive` and `schoolId`, and serves
   the bytes the same way as Task 5, versioned by `photoUpdatedAt`.
2. The photo in the student dashboard header, with a placeholder when absent.
3. "Add or change photo" linking to the deep link you name in Task 2. **No upload
   form on the JDSmartLearn side, ever.**
4. The student's own photo saved on their phone for offline reading, wiped on
   sign-out, student switch and expiry, like everything else in its device store.
5. Later, optionally: photos on the tutor's class list, network-only.

Reply with: the storage choice (Task 0), the exact deep-link path, the field
names as shipped if any differ from this prompt, and your backup retention.
