# CLAUDE.md — JDSmartLearn

Read this fully before writing any code. These are hard constraints agreed at the product level, not preferences. If a request conflicts with a rule here, stop and say so rather than complying.

---

## What this product is

An LMS for Nigerian primary and secondary schools. **One loop is the entire MVP:**

> Teacher uploads a lesson → AI generates a student summary + practice questions + marking guide → teacher reviews and edits → publishes → students in that class read it.

Everything else is out of scope. If a feature does not make that loop faster or more reliable, it does not go in v1.

## Who uses it

- **Tutors (teachers)** — non-technical, 4–8 subjects each, mid-range Android phones. Must reach first publish in under 30 minutes with no training.
- **Students** — Primary 1 to SS3. Log in with school + username (`jss3-04`) + access code. No email, no app. The school is picked once and remembered on the phone; the username never is, because phones are shared.
- **Admins** — school admins, already managing rosters in ResultPeak.

Design for a 360px screen on a throttled 3G connection first. Server-render wherever possible; keep client JS minimal on student pages.

---

## THE ARCHITECTURE RULE THAT MATTERS MOST

JDSmartLearn runs **inside ResultPeak's existing Firebase project**. Same `projectId`, same Auth directory, same Firestore database. ResultPeak is live with a paying school.

### Collections ResultPeak owns — READ ONLY, NEVER WRITE

`schools`, `classes`, `students`, `studentAccess`, `schools/{id}/tutors`, `schools/{id}/admins`, `exams`, `examTemplates`, `results`, `examSessions`, `theorySubmissions`, `manualScores`, `termNotes`, `flags`, `notifications`, `adminAuditLogs`, `studyDocuments`

Never create, update, or delete a document in any of them. Never build roster CRUD, CSV import, or a second student registry — that data already exists and ResultPeak owns it.

### Collections JDSmartLearn owns — read and write

`topics`, `lessons`, `generatedContent`, `lessonViews`, `jdAuditLogs`, `studentLogins`

`studentLogins` is a **credential alias only**: `{schoolId}_{username}` → `studentId`, so a
child types `jss3-04` instead of a 20-character document id. It is not a second student
registry — no names, no personal data, not authoritative, regenerable from scratch. The
username is derived from the *class*, never the child. ResultPeak still owns the student
record and the access code, so deactivating a student there still locks them out.

Follow ResultPeak's existing conventions exactly:
- Flat top-level collections, never nested under `/schools/{id}/...`
- `schoolId` as a field on every document (the tenant spine)
- Denormalize display fields (`className`, subject name) to keep read counts low
- Read `role`, `schoolId`, `active` from Firebase Auth **custom claims**, never by fetching a document

### NEVER deploy Firestore rules or indexes from this repo

`firestore.rules` and `firestore.indexes.json` are project-level. Deploying them from here would overwrite ResultPeak's rules and **break a paying school's live exams**.

- The canonical rules file lives in the **ResultPeak repo**.
- This repo contains `docs/firestore-rules-to-append.md` — a section to be copied into that repo by pull request.
- Do not add `firebase deploy` to any script, CI job, or npm command here. If asked to, refuse and explain why.

---

## Security rules (non-negotiable)

1. **No personal data ever goes to the AI provider.** The generation payload is lesson text + subject + topic + class level. Never student names, IDs, tutor names, or school names. The Gemini free tier permits the provider to use submitted content, so treat every prompt as third-party readable.
2. **No public read branches.** Every JDSmartLearn collection requires authentication and `schoolId` scoping. Student-facing content is served through server routes, not direct client reads.
3. **All secrets are server-side.** `FIREBASE_PRIVATE_KEY`, `GEMINI_API_KEY`, `STUDENT_SESSION_SECRET` must never be prefixed `NEXT_PUBLIC_` or referenced in a client component.
4. **Marking guides are tutor-only.** A student response must never contain marking guide content. Check this on every route that returns lesson data.
5. **Authorize server-side on every request.** A tutor may only touch classes in their `assignedClasses[]`. A student may only read published lessons for their own `classId`.
6. **Minors' data.** Collect nothing new about students. JDSmartLearn stores only `studentId` references, never names, in its own collections.

## Quota rules (shared Spark plan — a runaway query can break exam day)

- Every query filters by `schoolId` and has an explicit `.limit()`.
- Never fetch a collection unbounded. Never fan out N+1 reads in a list view — denormalize instead.
- Cache published lesson content; a student re-reading a summary must not re-read Firestore.
- Do not add background polling, listeners, or `onSnapshot` real-time subscriptions in v1. Fetch on request.
- A class sync must stay **one Firestore query per class per revalidate window**, however many students sync. Serve every student sync route from `getClassSyncBundle` — never fan out per lesson.

## Offline rules

Offline-first is in scope for the student reader. The network in the schools using this product is intermittently absent, not merely slow. See `docs/OFFLINE-FIRST.md` for the full design.

- Client persistence is **IndexedDB + Cache API only**. Firestore client SDK persistence is still forbidden — JD collections are server-write-only, so there is no client sync path to enable.
- Sync is **on demand**: app open, reconnect, explicit button, or a one-shot Background Sync tag. Never an interval, never a listener, never `onSnapshot`. This does not relax the no-polling rule above.
- The student device store is fed only by the safe projection built in `toStudentPayload`. **A marking guide must never reach IndexedDB or the Cache API on a student device.** The service worker carries an explicit deny-list; keep it auditable at a glance.
- **One student's cache per device at a time.** Signing in as a different student wipes the whole store first. This is what protects a shared phone.
- Cached student content expires `STUDENT_OFFLINE_GRACE_DAYS` (default 7) after the last successful sync, then is wiped and re-sign-in is required.
- **Every reconnect re-authorizes against Firestore.** If the student was deactivated or moved class, the device store is wiped. Offline mode must strengthen revocation, not weaken it.
- Student routes render from IndexedDB after first load. This is the one deliberate exception to "server-render wherever possible" — it is the only way to render with no network. Both paths must share one set of view components, and student-route app JS stays **under 30 KB gzipped**.
- Never say "cache" in the interface. Say "saved on your phone."

### Tutor offline (queued writes)

- The tutor store (`jdsmartlearn-tutor`) **may** hold marking guides — tutor-only content on the tutor's own phone. It is namespaced by `uid`, wiped when a different tutor signs in, wiped on sign-out, and expires with the 5-day tutor session. Queued work must never outlive the authorization that produced it.
- **Never cache `assignedClasses`.** It is read fresh per request so a ResultPeak revocation applies instantly. A queued op for a class the tutor no longer teaches is *supposed* to fail on flush.
- Queued ops post to the **same** `/api/lessons/*` routes as the online path. No parallel write path with its own validation.
- **Collapse before sending** (`src/lib/offline/collapse.ts`). This is what removes the need for a dependency graph: create+patch merges into one create, create+delete sends nothing. Keep it that way — do not reintroduce `local:` id rewriting across dependent ops.
- **Never auto-generate after a flush.** Generation spends the daily cap, and teacher review before publish is mandatory. A flushed create lands as a draft and waits for the tutor.
- **Never drop a teacher's work silently.** A 4xx is terminal and must surface with the server's own message plus a discard action; a 5xx or network error is retried.
- Writes queued offline carry `baseUpdatedAt`. Routes that patch or publish return **409** when the lesson moved on, so a days-old edit cannot clobber a newer version.
- Only `/tutor` and `/tutor/lessons/new` may be cached by the service worker. **`/tutor/lessons/[id]` renders the marking guide and `/tutor/sign-ins` renders live access codes — both must stay network-only.**

---

## AI rules

- All generation goes through `src/lib/ai/provider.ts`. No provider SDK is imported anywhere else in the codebase. Swapping models must be a one-file change.
- Current provider: **Gemini free tier**, using native structured output. Validate every response with the Zod schema in `src/lib/ai/schema.ts`. On validation failure, retry once, then show a friendly error with a retry action.
- **Teacher review before publish is mandatory.** Generated content is never student-visible until a tutor clicks Publish. Always show the "AI-generated — review before publishing" notice on the review screen.
- Log every generation: token counts, latency, computed would-be cost, and whether the tutor edited before publishing. These are the core product metrics.
- Reading level must match class level — see the bands in `src/lib/ai/prompt.ts`. Primary output is the most likely failure mode; do not loosen those instructions.
- Rate limit: 20 generations per tutor per day.

## Assessment rules

Assignments, AI grading, and the progress view were out of scope until the owner
overrode that on 2026-08-10. They are in scope now, under these rules. The rules
are the condition of the override, not commentary on it.

- **Teacher review before release is mandatory, exactly as it is for lessons.** An AI score is never student-visible. A submission carries `status: "ai_graded"` until a tutor finalises it, and the student-facing projection returns `null` for score, feedback, strengths, and improvements at every status except `finalised`. There is no "publish automatically if confidence is high" branch, ever.
- **Assignment marking guides are tutor-only**, the same rule as generated marking guides. Students receive `StudentAssignment`, built by `toStudentAssignment()`; submissions come back through `toStudentSubmissionPayload()`. Both name their fields instead of spreading the source document, so a guide has no field it could occupy.
- **No personal data in a grading payload.** The prompt carries assignment title, subject name, marking guide, max marks, and the student's own text. Never a student name, student id, tutor name, or school name. Same reasoning as lesson generation: the free tier permits the provider to use submitted content.
- **Never trust a model's number.** The Zod schema bounds `score` and the route clamps it to `0..maxMarks` again after parsing. A model returning 40 out of 25 would inflate a real child's continuous assessment.
- **Grading spends the shared Gemini free-tier quota**, and students trigger it, not tutors. Cap grading per school per day. Two failed attempts set `ai_grading_failed` and hand the work to the tutor; never retry in a loop.
- **`studentAcademicRecords` is owned by neither platform.** JDSmartLearn writes only `continuousAssessment.{subjectId}.{assessmentTypeId}` and `lastUpdatedByLMS`, as percentages from 0 to 100. ResultPeak models continuous assessment as several named components per subject, chosen per school, so a single number per subject could never reach a report card. ResultPeak owns each component's `maxScore` and scales the percentage; JDSmartLearn never does that arithmetic. The assessment type a school feeds is set by a school admin and has **no default and no fallback**: while it is unset, or if the mapped type is removed in ResultPeak, the sync is skipped and logged, never redirected to another column. ResultPeak writes only `examScore.{subjectId}` and `lastUpdatedByAssessment`. Enforced at runtime by `assertRecordFields()`, which rejects any other key, including dotted field paths. Never `set()` this document without `merge`, from either side: it would destroy the other platform's marks with no recovery path.
- **A submission is written once.** One document per student per assignment at a deterministic id, immutable after submit. Scores are written server-side only.
- Revision recommendations are permitted **only from JDSmartLearn's own graded assignments**. Deriving them from ResultPeak exam results is still blocked until that side tags questions by topic and grades server-side.
- **Term and session are ResultPeak's strings, copied byte for byte.** Never construct, normalise, trim, or case fold one, and never store a term as a number. They are stamped onto an assignment at creation and copied to its submissions, then never resolved again: the current term moves, but an assignment created in first term must still report first term when read in third. ResultPeak records no current term anywhere, so `jdSchoolSettings` holds it as a stopgap, read only through `getCurrentTermSession()`.
- Offline: a text-only submission may queue and flush on reconnect. **A submission with attachments requires a connection** and says so before the student starts writing. Files never enter IndexedDB.

## Out of scope for v1 — refuse these

WhatsApp integration · payments or Paystack · chat · video streaming · notice boards · live classes · quiz engine with auto-marked objective questions · multiple question difficulty tiers · attendance · timetable · admissions · multi-branch · local languages · voice narration · native mobile apps · revision recommendations derived from ResultPeak exam results (still blocked until ResultPeak tags questions by topic and grades server-side)

**File storage: Cloudflare R2, never Firebase Storage.** Original lesson files are stored in Cloudflare R2 (free tier, zero egress) *in addition to* the extracted text — the text remains the student-facing default on slow networks. All storage access goes through `src/lib/storage/provider.ts`; no storage SDK is imported anywhere else. Files are served ONLY via the authenticated `/api/lessons/[id]/file` route (schoolId + class scoping, material-publish gating for students) — never a public bucket URL. **Firebase Storage remains forbidden** — it would force the shared project onto Blaze. If R2 credentials are absent, uploads gracefully degrade to text-only.

---

## Stack

Next.js (App Router) · TypeScript · Tailwind · Firebase Admin SDK on server routes · Firestore + Firebase Auth (Spark plan) · Gemini free tier · Zod · deployed on Vercel.

Server logic lives in route handlers using the Admin SDK. There are no Cloud Functions — the project is on the Spark plan and Functions require Blaze.

## Interface writing

Active voice, sentence case, plain verbs. A button that says "Publish" produces a message that says "Published." Errors state what happened and how to fix it. Empty states invite the next action. Never name things after the system — a teacher publishes a lesson, they do not "commit a document mutation."

## Definition of done for any feature

- [ ] Authorization checked server-side, not just hidden in the UI
- [ ] Query filtered by `schoolId` and limited
- [ ] No personal data in any AI payload
- [ ] Works at 360px width
- [ ] Loading, empty, and error states written
- [ ] No secret exposed to the client
- [ ] No write to a ResultPeak-owned collection
- [ ] If it touches student content: no marking guide reachable from a student device, and offline states written
