# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository.

**This one is mostly a boundary agreement, not a build.** JDSmartLearn has
shipped school announcements — the notices a school office sends to students and
tutors about resumption dates, exam timetables, and changes to activities. It
owns them completely. The reason this document exists is that ResultPeak already
has a `notifications` collection and school admins already live in ResultPeak's
admin area, so there are two plausible homes for the feature and picking one
late is expensive.

**Ordering: JDSmartLearn has already shipped and nothing here blocks it.** Tasks
1 and 2 are a one-line rule change and a link. Task 3 is optional and only worth
doing if school admins ask to post from ResultPeak.

---

## Context

You are working in **ResultPeak**, a school exam/results platform, live on
Firebase project `resultpilot-ddf7c` (Spark plan), with a paying school running
real exams in it.

A sibling product, **JDSmartLearn** (an LMS for the same schools), runs inside
the *same* Firebase project — same `projectId`, same Auth directory, same
Firestore database. It reads ResultPeak's collections and never writes to them.

JDSmartLearn now has an announcements feature:

- A school admin or a tutor writes a notice with a title, a short body, a
  category (resumption / exam / event / urgent / general), and an optional
  start and expiry date.
- It lands on the dashboards of every student in the target class — or every
  student in the school — as a card that **stays until the child dismisses it**.
- Tutors get the same on their own dashboard.
- It is one-way. There is no reply, no thread, no reaction. That is a hard rule
  in JDSmartLearn's `CLAUDE.md` ("never a channel"), because an announcement you
  can answer is chat, and chat is out of scope in that product.

It is stored in `jdNotifications`, a **JDSmartLearn-owned** collection that
already existed for tutor notifications and the class activity feed, extended
with an `audience: 'school'` value and a few fields.

## The decision, already made

> **JDSmartLearn owns `jdNotifications` outright. ResultPeak never writes it.
> JDSmartLearn never writes or reads ResultPeak's `notifications`.**

Both halves matter, and the second is the one that is easy to get wrong later.

**Why not put announcements in ResultPeak's `notifications`?** Because the
audience is wrong in both directions. ResultPeak's notifications are addressed to
staff about exam workflow — a result needing approval, a flagged script. Students
do not read them, and students are the entire point of this feature. And
`notifications` is a ResultPeak-owned collection that JDSmartLearn is forbidden
from writing at all: the LMS would have to ask ResultPeak to post on its behalf
for every notice a tutor writes about their own class.

**Why not mirror one into the other?** Because a mirror is two sources of truth
with a lag, and the failure is silent: a notice edited in one place and read from
the other tells a parent the wrong resumption date, and nothing errors.

**If school admins ask to post announcements from ResultPeak** — which is
plausible, since that is where they already work — the answer is **Task 3 below:
a ResultPeak composer that calls a JDSmartLearn route**. One store, one truth,
two front doors. Not a second collection.

## Hard constraints

- A paying school is running live exams in this project. Nothing here may change
  exam behaviour.
- Every Firestore query filters by `schoolId` and carries an explicit `.limit()`
  — the Spark quota is shared with JDSmartLearn.
- **Announcements carry no personal data.** No student name, no mark, no
  per-child text. One document is read by a whole class; that is what keeps a
  class of forty from costing forty writes for one notice. If a notice needs to
  say something different to two children, it is not an announcement.

---

## Task 1 (P0) — The rules block

`docs/firestore-rules-to-append.md` in the JDSmartLearn repo carries the block to
copy into the canonical `firestore.rules` here. It adds `jdReadState` and
`schemes`, and **replaces** the existing `jdNotifications` block rather than
adding a second one — two match blocks on one path both evaluate, and the
permissive one wins.

Three things to check before you paste it:

1. **`isMember()` and `isSchoolAdmin()` must still exist** in the canonical file.
   The block calls both. A call to a helper that does not exist fails to compile
   and takes the entire working ruleset down on deploy, live exams included.
2. **No student branch appears anywhere in it, and none may be added.** Students
   have no Firebase Auth identity in this project at all — they sign in with
   school + username + access code against a server-minted session cookie, so
   `request.auth` is null for every one of them. A student branch could only be
   written as a public read branch, which JDSmartLearn's `CLAUDE.md` forbids
   outright. Announcements reach a student through an authenticated server route
   using the Admin SDK.
3. `jdReadState` is **admin-read, not member-read**, deliberately narrower than
   the others. A tutor has no reason to see which children have opened a notice,
   and JDSmartLearn's "never a channel" rule refuses per-reader delivery receipts
   shown back to an author. Please keep it that way when you paste it.

This is defence in depth, not a blocker: all three collections are reached only
through the Admin SDK on server routes, which bypasses rules entirely.

## Task 2 (P1) — Point staff at it

School admins are in ResultPeak's admin area most of the day. Add a link from
wherever school-wide settings live to JDSmartLearn's announcements composer,
worded so it is obvious what it does and where it lands:

> **Announcements** — send a notice to students and teachers in JDSmartLearn.
> Resumption dates, exam timetables, changes to activities.

Use the same cross-link mechanism the two products already share — see
`docs/resultpeak-cross-link.md` in the JDSmartLearn repo. Staff sign in there
with their own ResultPeak account and their claims carry `schoolId`, so the link
needs no school in the path.

## Task 3 (P2, only if asked for) — Post from ResultPeak

Do this **only** if school admins actually ask to write announcements without
leaving ResultPeak. It is not speculative work worth doing early.

The shape, if it happens:

- A composer in ResultPeak's admin area that `POST`s to JDSmartLearn's
  `/api/tutor/announcements` route with the admin's Firebase ID token.
- That route already authorizes school admins and already validates every field.
  **Do not reimplement the validation here**, and above all do not write
  `jdNotifications` directly from this repo — the ownership rule is the point of
  this whole document, and a direct write is how it quietly stops being true.
- JDSmartLearn will need to accept a bearer ID token on that route in addition to
  its session cookie. Tell us before you start and we will ship that first; it is
  a small change and it must land **before** the composer, not after.

**What must not happen:** an announcements collection in this repo, a mirror job,
or a `notifications` document that a JDSmartLearn route reads. Any of the three
gives a school two places to edit the same resumption date.

---

## What JDSmartLearn does after this ships

- After Task 1: nothing changes functionally; the collections are simply no
  longer reachable by a client SDK.
- After Task 2: nothing. The link points at a route that already exists.
- After Task 3, if it happens: accepts a bearer token on
  `/api/tutor/announcements`, and that is all.

## Definition of done

- [ ] The rules block pasted, with `isMember()` / `isSchoolAdmin()` confirmed to
      exist first
- [ ] No student branch, and no public read branch, on any JD collection
- [ ] `jdReadState` left admin-read
- [ ] Emulator tests run before deploy
- [ ] No announcements collection created in this repo
- [ ] No exam behaviour changed
