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

`schools`, `classes`, `students`, `studentAccess`, `schools/{id}/tutors`, `schools/{id}/admins`, `exams`, `examTemplates`, `results`, `examSessions`, `theorySubmissions`, `manualScores`, `termNotes`, `flags`, `notifications`, `adminAuditLogs`, `studyDocuments`, `attendance`

Never create, update, or delete a document in any of them. Never build roster CRUD, CSV import, or a second student registry — that data already exists and ResultPeak owns it.

**`attendance` and `termNotes` are read-only in a stronger sense than the rest, and "don't mirror it" is part of the rule.** `attendance` is one document per class per day at the deterministic key `{schoolId}_{classId}_{YYYY-MM-DD}`, written only by the named class teacher; `termNotes` holds term comments and skill ratings and is class-teacher-only once a school enables subject allocation. Because the attendance id is deterministic, a write from here does not create a stray parallel record somebody could spot and delete — it lands on top of the real register, and afterwards neither side can tell which entries were the teacher's. If either is ever needed here, READ it. Copying one into a JD collection is the same problem with an extra step: the copy drifts silently the first time a teacher edits the original. Attendance is separately out of scope as a feature — see the v1 list.

### Collections JDSmartLearn owns — read and write

`topics`, `lessons`, `generatedContent`, `lessonViews`, `jdAuditLogs`, `studentLogins`,
`assignments`, `submissions`, `studentProgress`, `jdNotifications`, `jdSchoolSettings`,
`jdCaScores`, `jdReadState`, `schemes`

`src/lib/db/collections.ts` is the runtime source of truth for this list and
carries the reasoning for each. Keep the two in step: a collection that exists
in code but not here is one nobody reviews.

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

### A change here that implies a change in ResultPeak must be said out loud, then written as a prompt

The two products share one Firebase project but not one repository, and nobody
is watching the seam. A JDSmartLearn change that quietly assumes a ResultPeak
change lands as a silent breakage in a paying school's live product — or as a
workaround in this repo that outlives the reason for it.

So: **before finishing any change, ask whether it needs something from the
ResultPeak side. If it does, three things happen, and none of them is optional.**

1. **Alert in the reply, unprompted and up front.** Not a footnote after the
   diff. State what ResultPeak must do, and state the **ordering** — whether the
   JDSmartLearn change is safe to ship first, or must wait behind the ResultPeak
   one. A guard that must exist before this repo writes its first document is a
   blocker, and saying so late is the same as not saying it.
2. **Write the ResultPeak prompt.** A complete, ready-to-paste prompt for a fresh
   Claude Code session opened in the **ResultPeak** repository — that session has
   none of this context and cannot infer it. Follow the shape of
   `docs/resultpeak-shared-login-prompt.md`: context, hard constraints, the
   invariants to hold, the concrete work, and what JDSmartLearn does after it
   ships. Save it as `docs/resultpeak-<topic>-prompt.md` and name the file in the
   reply. Never hand over a one-line "ResultPeak should also do X."
3. **Route it to the right existing file when one exists.** Rules changes append
   to `docs/firestore-rules-to-append.md`; indexes to
   `docs/firestore-indexes-to-append.md`; something broken on their side, found
   from here, to `docs/resultpeak-defects.md`. A prompt may point at those rather
   than restate them.

Changes that trigger this — the list is illustrative, not exhaustive, and the
default when unsure is to raise it:

- A new or changed Firestore query that needs a **composite index**.
- Any **security rule** this repo's reads or writes depend on, including a guard
  that must land *before* JDSmartLearn writes.
- Reading a **field ResultPeak does not reliably write yet** — including a field
  that exists on some documents and not others.
- Anything about **custom claims**: a new claim, a changed value, a role name.
- Any change to what this repo writes into a **shared document**
  (`studentAcademicRecords`), including a new assessment type mapping.
- **Ownership moves** in either direction — a collection, a credential, an id
  format, a username scheme.
- **Term and session strings**, the current-term source, or anything that has to
  match ResultPeak byte for byte to join.
- Roster, access code, or onboarding behaviour this repo depends on but must
  never implement.

Then keep building. Raising the dependency does not mean stopping: deliver the
JDSmartLearn side under a stated assumption unless shipping it first would write
bad data or break their live product, and say plainly which of those it is. Do
not paper over the gap with a workaround here without naming it as a workaround
and recording the real fix.

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
- **`studentAcademicRecords` is owned by neither platform.** **JDSmartLearn writes `continuousAssessment.{subjectId}.{assessmentTypeId}` and `lastUpdatedByLMS`, and nothing else.** State the rule that way round and keep it that way round: what this repo may write is the short, stable list, and every other field root is refused by default whether or not anyone here knows who owns it. Do not restate this as a list of ResultPeak's fields. Such a list fails open, because a field added over there stays writable from here until somebody remembers to add it, and it drifts silently: ResultPeak's rules comment claimed four owned fields where these docs claimed two, and neither side noticed. CA values are percentages from 0 to 100. ResultPeak models continuous assessment as several named components per subject, chosen per school, so a single number per subject could never reach a report card. ResultPeak owns each component's `maxScore` and scales the percentage; JDSmartLearn never does that arithmetic. The assessment type a school feeds is set by a school admin and has **no default and no fallback**: while it is unset, or if the mapped type is removed in ResultPeak, the sync is skipped and logged, never redirected to another column. Enforced at runtime by `assertRecordFields()`, an allowlist, which refuses every other field root **at every depth**: a top-level key, a dotted field path, and a nested key alike, because `set` with `merge` deep-merges maps. Never `set()` this document without `merge`, from either side: it would destroy the other platform's marks with no recovery path.
- **A submission is written once.** One document per student per assignment at a deterministic id, immutable after submit. Scores are written server-side only.
- Revision recommendations are permitted **only from JDSmartLearn's own graded assignments**. Deriving them from ResultPeak exam results is still blocked until that side tags questions by topic and grades server-side.
- **The annual average is ResultPeak's arithmetic, and JDSmartLearn knows nothing about it.** ResultPeak computes an end-of-session annual average from the three term percentages, along with term weights, promotion marks and class position. None of that is modelled here. Do not add an annual field, do not aggregate a mark across terms, and do not compute a year figure anywhere in this codebase, however easy it looks from a subject's CA map. What this repo may write to the shared record is unchanged by it: `continuousAssessment.{subjectId}.{assessmentTypeId}` and `lastUpdatedByLMS`, and `assertRecordFields()` stays an allowlist. Widening that list is not how an annual figure gets shipped.
- **A mismatched term or session drops out of a join in silence, so check before a pilot, never after.** The annual average joins terms by exact string match. A pair that does not match does not error and does not blank the report: the term is simply absent from the average and a plausible number still prints. `npm run diagnose:terms <schoolId>` lists every distinct pair on this repo's assignments and submissions, counts the rows, and marks each matched or unmatched against that school's ResultPeak data. It is read-only through `readOnlyDb()` and it repairs nothing, deliberately: deciding which of two session strings a school's history should collapse onto is a decision about a paying school's result sheets. See `docs/resultpeak-defects.md`, defect 1, for what it currently finds.
- **Term and session are ResultPeak's strings, copied byte for byte.** Never construct, normalise, trim, or case fold one, and never store a term as a number. They are stamped onto an assignment at creation and copied to its submissions, then never resolved again: the current term moves, but an assignment created in first term must still report first term when read in third. ResultPeak records no current term anywhere, so `jdSchoolSettings` holds it as a stopgap, read only through `getCurrentTermSession()`.
- Offline: a text-only submission may queue and flush on reconnect. **A submission with attachments requires a connection** and says so before the student starts writing. Files never enter IndexedDB.

## Announcement rules

Notice boards were out of scope until the owner overrode that on 2026-08-22.
Announcements, the student subject shelf and tutor-uploaded schemes of work are
in scope now, under these rules. The rules are the condition of the override,
not commentary on it.

- **An announcement is school content, never personal content.** It carries a
  title, a short body, a category and a date window — no student name, no mark,
  no per-child text, nothing derived from one reader. That is what lets ONE
  document be read by a whole class. The moment an announcement needs to say
  something different to two children, it is not an announcement and does not
  belong here.
- **No push, no polling, no listeners, no `onSnapshot`.** Announcements arrive on
  the existing on-demand sync triggers — app open, reconnect, explicit button,
  one-shot Background Sync tag — folded into the responses those triggers already
  make. This does not relax the no-polling rule in Quota rules; it is that rule.
  **"Urgent" is a tone, not a delivery mechanism.** A loud red card that arrives
  on the next sync is the whole feature; a notice that must arrive faster than
  the next sync is a different product and needs its own decision.
- **Read state is per reader, never per reader × announcement.** One
  `jdReadState` document per person, holding a `seenAt` high-water mark and a
  capped list of individually dismissed ids. The obvious
  `{announcementId}_{studentId}` shape is announcements × students documents
  forever, on a quota shared with a live school's exam day.
- **Never AI-generated.** A resumption date is a fact a school states, not a
  draft a model proposes. No announcement text goes through
  `src/lib/ai/provider.ts`, and none is ever sent to the provider.
- **Never a channel.** No replies, no threads, no reactions, no per-reader
  delivery receipts shown back to the author. Chat stays out of scope, and an
  announcement that can be answered is chat.
- **Authorship is scoped like every other write.** A school admin may address the
  whole school or any class in it; a tutor may address only classes in their
  `assignedClasses`, read fresh from ResultPeak on the request. Checked
  server-side, on every request, never by hiding the picker.
- **JDSmartLearn owns `jdNotifications` outright.** ResultPeak's `notifications`
  collection stays untouched in both directions: this repo never writes theirs
  and never reads theirs into a JD feed. If the school office ever wants one
  place to post from, the move is a ResultPeak composer calling a JD route — not
  a second feed to keep in step. See `docs/resultpeak-announcements-prompt.md`.

### Subject shelf rules

- **A subject list is derived, and the derivation is labelled.** ResultPeak has
  no per-student and no per-class subject list: `schools/{id}.subjects[]` is
  school-wide and `classes/{id}` carries no subjects at all. The only
  class-to-subject link in the shared project is the tutor allocation
  `schools/{id}/tutors/{uid}.subjectClasses`. Until ResultPeak owns
  `classes/{id}.subjectIds[]`, the shelf is the union of that allocation with the
  subjects that actually have a lesson or an assignment for the class. This is a
  workaround, it is named as one in the code, and the real fix is
  `docs/resultpeak-class-subjects-prompt.md`.
- **`lessons` carry `term` and `session`, stamped once at creation and copied
  verbatim**, exactly as assignments already do. Never re-resolved on read: a
  lesson created in first term still reports first term when read in third.
  Lessons that predate the field read `null` and show under "Earlier" — a term is
  never guessed from a timestamp.
- **`Topic.term` is not an academic term.** It is JDSmartLearn's own `1 | 2 | 3`
  curriculum ordering, seeded from `seed/topics/`, and it takes part in no
  ResultPeak join. Never compare one to an `AcademicTerm`, never render one as
  the other.
- **The shelf shows JDSmartLearn's own record only.** Lessons, schemes,
  assignments, and CA percentages computed here from finalised submissions.
  ResultPeak's exams and results are linked out, never restaged: duplicating
  their surface is how two products drift into disagreeing about a child's marks.

### Scheme of work rules

- **Never AI-generated and never sent to the provider.** A scheme is the school's
  own curriculum document. Summarising it would invent curriculum, and it must
  not spend the daily generation cap.
- Stored in Cloudflare R2 through `src/lib/storage/provider.ts` and served only
  through an authenticated route, the same as lesson files. Never a bucket URL.
- A scheme has no marking guide and no field one could occupy, so it is safe for
  the student device store. It is the ideal thing to save on a phone.

## School branding rules

Per-school branding was added on 2026-08-27, on the owner's call that the product
read as a third party a school had linked out to. **The school leads: its name
and crest are the first thing on every signed-in screen, JDSmartLearn is the
small line underneath, and the ilumo endorsement appears only in the footer and
on the unbranded front door.** This amends `docs/ilumo-brand.md` section 1, which
is shared with ResultPeak. Full design in `docs/SCHOOL-BRANDING.md`; the
cross-repo half in `docs/resultpeak-school-branding-prompt.md`.

- **ResultPeak owns branding. Decided 2026-08-29. This repo reads and never
  writes.** `schools/{id}.branding` is the source of truth over there and
  `schoolBranding/{id}` is its public projection, written by exactly one writer.
  This repo reads the **projection**: it is the smaller document, it is the one
  ResultPeak's own signed-out client reads, and it carries `logoUpdatedAt`, which
  moves only when the crest bytes move. `schools/{id}` is still read for `name`
  and `isActive`. Both collections are refused by `assertWritable()`.
  For two days in August this repo had a rival branding record in
  `jdSchoolSettings`, an R2 crest and its own editor. **All three are gone, not
  deprecated.** A form left running is a form somebody uses, and then two
  records disagree about what a school looks like. Nothing was lost: measured
  before removal, zero schools had a crest in R2, zero had an icon-eligible
  crest, and no settings document had a `branding` map at all. Crest, colour and
  short name are edited once, in ResultPeak's school profile.
  **A missing projection means the school is GONE**, not un-backfilled:
  ResultPeak deletes it as a stage of its purge cascade. Render the plain product
  lockup, never a stale cached crest.
- **The crest is served as bytes, never shipped as a data URI in a sync
  response.** ResultPeak's crest is 77 to 81 KB of base64. `/api/schools/{id}/logo`
  decodes it server-side, so the student sync payload carries a ~220 byte
  versioned URL instead. Measured: 206 to 238 bytes against 77.6 to 81.3 KB.
  This matters because `/api/student/sync` ETags its whole body, so an inline
  crest would cost every child in a class a fresh 81 KB every time a tutor
  published a lesson. It is also what keeps the crest offline-safe: same-origin,
  already on the service worker's allowlist, and versioned by `logoUpdatedAt` so
  a motto edit does not bust it. **A cross-origin crest cannot survive offline**,
  because the service worker refuses every cross-origin request and that deny
  list does not change, so an https crest is never proxied and degrades to the
  monogram.
- **`getSchoolBrand()` is the ONLY read of school branding**, and it caches the
  projection, never a school document. `getSchool()` is deliberately uncached
  because of `assessmentTypes`; nothing may reintroduce a cached school object
  for a later caller to reach into.
- **A signed-in surface takes `schoolId` from the session. Never from a cookie.**
  Any visitor can set the school cookie by opening `/s/anything`, so it may
  decorate a pre-authentication screen and nothing else. Showing a teacher the
  wrong school's crest above their own class's data is the failure this prevents.
- **Never blank.** A school that has configured nothing still shows its own name
  and a derived monogram. A feature that renders an empty header until an admin
  acts has shipped broken for every school at once.
- **A pinned device is not offered another school.** Arriving through the
  school's own link suppresses the picker and the "Change school" link in both
  audiences. `?school=change` keeps working when typed — stop advertising the
  escape hatch, never remove it, or a transferring child is stranded.
- **A school colour never becomes the action colour or a status colour**, and one
  that cannot carry text at 4.5:1 is refused with its measured ratio, not
  silently corrected. Validated by one function called from both the write path
  and CI.
- **Branding is not personal data and must never become it.** A crest, a name, a
  colour, a motto. Nothing about a child, a member of staff or a mark — that is
  what lets it render before anyone has signed in, and what keeps it safe in the
  student device store.
- **No school name in an AI payload.** Unchanged, and worth restating here
  because this work puts `school.name` within easy reach of the generation path.


## Out of scope for v1 — refuse these

WhatsApp integration · payments or Paystack · chat · video streaming · live classes · quiz engine with auto-marked objective questions · multiple question difficulty tiers · attendance · timetable · admissions · multi-branch · local languages · voice narration · native mobile apps · revision recommendations derived from ResultPeak exam results (still blocked until ResultPeak tags questions by topic and grades server-side)

**"Notice boards" left this list on 2026-08-22** and became Announcement rules
above. `chat` did not move and is not adjacent to it: an announcement is a
one-way school notice with no reply path, and the "never a channel" rule is what
keeps the two apart. A request to let students respond to an announcement is a
request for chat and is still refused.

**File storage: Cloudflare R2, never Firebase Storage.** Original lesson files are stored in Cloudflare R2 (free tier, zero egress) *in addition to* the extracted text — the text remains the student-facing default on slow networks. All storage access goes through `src/lib/storage/provider.ts`; no storage SDK is imported anywhere else. Files are served ONLY via the authenticated `/api/lessons/[id]/file` route (schoolId + class scoping, material-publish gating for students) — never a public bucket URL. **Firebase Storage remains forbidden** — it would force the shared project onto Blaze. If R2 credentials are absent, uploads gracefully degrade to text-only.

**There is exactly ONE unauthenticated file route, and it is `/api/schools/[schoolId]/logo`.** It exists because the screen that most needs a school's crest is the sign-in screen, where nobody has a session yet, and a school's front door showing a grey box until you log in defeats the point of branding it. The exception is bounded and stays bounded: the URL names a **school** and nothing else. There is no storage key anywhere in the path: the bytes are decoded from the data URI on that school's own branding record in `schoolBranding`, so there is no object store for a crafted path to reach into. This got strictly narrower when ResultPeak took ownership of the crest. It 404s for a school that is missing, inactive or has no crest; the `Content-Type` comes from a server-side allowlist (`src/lib/branding/crest.ts`), never from the request or the stored object; SVG is served with a null CSP and `nosniff` because an SVG can carry script. What it returns is a logo the school prints on a uniform: no student data, no marking guide, and nothing worth enumerating. **Do not add a second route to this exception.** If another asset needs to render before sign-in, that is a design conversation, not a copy-paste.

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
