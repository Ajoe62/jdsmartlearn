# Offline-first mode — design and implementation plan

Status: **all phases built.** Student offline reading, the read-receipt queue, revocation on reconnect, opt-in file saving, and the tutor write queue. Phase 5 (assessment) was added on 2026-08-10 and is described in §12. The CLAUDE.md amendment in §1 has been applied. Not yet exercised on a real device. See the manual checklist in §11.

---

## Context

Schools using JDSmartLearn are on networks that are not merely slow but **intermittently absent**. The current build assumes connectivity at every step: student pages are server-rendered on each request, the tutor loop posts synchronously, and a dropped connection mid-flow loses work. A teacher who prepares lessons at home with no data cannot start. A student whose school has no signal until break time cannot read anything.

The goal is that **both halves of the core loop survive a dead network**:

- A student who synced once can read every published lesson for their class, with no signal, for a school week.
- A tutor can compose and edit lessons offline; the work uploads itself when signal returns.

Non-goal: AI generation offline. Generation requires Gemini and stays online-only. Offline tutors queue *intent*; generation happens on reconnect.

### Why this needs care rather than a PWA plugin

Three constraints in this codebase make the obvious approaches wrong:

| Constraint | Consequence |
|---|---|
| Every JD collection is `allow write: if false`, `generatedContent` is `read, write: if false` ([docs/firestore-rules-to-append.md](firestore-rules-to-append.md)) | **Firestore offline persistence is impossible.** Sync must go through the Admin-SDK route handlers. There is no client Firestore path to enable. |
| Spark plan shared with a live paying school ([CLAUDE.md](../CLAUDE.md) §Quota) | A naive per-student sync is an N+1 against `generatedContent`. One class of 40 syncing each morning would cost thousands of reads. §4 removes that entirely. |
| Marking guides are tutor-only ([src/lib/db/lessons.ts:186-203](../src/lib/db/lessons.ts#L186-L203)) | The student device store must be fed by the existing safe projection, never by `getGeneratedContent`. §5 makes this structural, not a convention. |

---

## 1. Product amendment — applied

[CLAUDE.md](../CLAUDE.md) no longer lists offline mode as out of scope. It now carries an **Offline rules** section holding the hard constraints this design depends on: IndexedDB + Cache API only (no Firestore client persistence), sync on demand only, no marking guide on a student device, one student's cache per device, a bounded grace window, re-authorization on every reconnect, and a 30 KB client-JS budget for student routes.

Read that section before changing anything here — it is the short version of this document, and it is what a future session will be held to.

---

## 2. Architecture in one picture

```
ONLINE, first visit            OFFLINE / repeat visit
─────────────────────          ──────────────────────────
server component                service worker
  getStudentSession()             serves cached app shell
  getClassSyncBundle()            (contains no student data)
  ↓ props                              ↓
<LessonReaderView>  ←── same component ──→  <LessonReaderView>
  ↓ writes                                     ↑ reads
        ╰─────────→  IndexedDB  ←──────────────╯
                         ↑
                    /api/student/sync   (index, ETag'd)
                    /api/student/lessons?ids=  (study guides)
                    /api/student/lessons/[id]/material
                         ↑
                  unstable_cache — ONE Firestore query
                  per class per 5 minutes, all students
```

Two decisions worth stating plainly:

**After the first load, student pages render on the client from IndexedDB.** The server becomes a data API. This is a deliberate departure from *"server-render wherever possible"* in CLAUDE.md — it is the only way to render with no network. The mitigation is that both paths use **the same view components**, so there is one renderer and no drift, and SSR remains for the cold first visit and no-JS fallback. Budget: **≤ 30 KB gzipped** of app JS on student routes, excluding the Next runtime. If a change would exceed that, it does not ship.

**Navigation is shell-first (cache-first), not network-first.** On a throttled 3G link a 4s network-first timeout is exceeded routinely even when online, so network-first would serve the fallback most of the time anyway while feeling slow. Shell-first loads instantly always, then refreshes data in the background.

---

## 3. Phasing

Each phase is independently shippable and independently valuable.

| Phase | Contents | Value if you stop here |
|---|---|---|
| **0** | `studentPayload` denormalization + backfill; view-write reduction | Fixes a real N+1 and a per-render write. Pure quota win, no offline yet. |
| **1** | PWA manifest, service worker, IndexedDB, sync API, app shell, offline UI | **Students read offline.** The largest user population, the biggest win. |
| **2** | View queue, session refresh + revocation-on-reconnect | Metrics survive offline; security posture improves. |
| **4** | Opt-in PDF/DOCX offline | Original files available without signal. |
| **3** | Tutor write queue | Teachers prep offline. |

Phase 4 was built before Phase 3 because it closed a live defect: the Phase 1 reader decided whether to show the original-file link from whether the *material text* was saved, so offline it could offer a download the service worker had never cached — a dead tap. `isFileSaved()` now gates it, and an unsaved file gets an explanation instead of a broken link.

### Phase 3 needs no dependency chaining

The plan assumed the tutor outbox would need `local:` id rewriting across dependent ops, with blocked-dependent bookkeeping when a create failed. It doesn't, because of one observation: **a `publish` can never follow an offline `create`** — generation sits between them and generation is online-only.

That leaves only create→patch, create→attach-file and create→publish-material, and all three collapse ([`src/lib/offline/collapse.ts`](../src/lib/offline/collapse.ts)):

| Queued offline | Sent |
|---|---|
| create + patch + patch | one create with the final values |
| create + publish material | one create with `publishMaterial` |
| create + delete | nothing at all |
| patch + patch on a server lesson | one patch, last value per field, oldest baseline |
| anything + delete | just the delete |

`POST /api/lessons` gained an optional `publishMaterial` flag to absorb the third case. After collapsing, every remaining op either creates a lesson (self-contained) or targets an id the server already knows — so there is no graph to maintain. Four offline edits to one lesson become one request, which also matters on a dying link.

**Do not reintroduce chaining.** The collapse tests in `scripts/test-offline.ts` are what stand in for it.

### Stale writes — the problem the plan missed

An offline edit can arrive days after an admin changed the same lesson, and `PATCH /api/lessons/[id]` writes only fields that differ from *current* state, so it would silently clobber. Queued ops now carry `baseUpdatedAt`; patch and publish return **409** with *"This lesson changed while you were offline"* and the tutor's work is kept for them to decide. Only enforced when a baseline is supplied, so the online forms are unaffected.

---

## 4. Phase 0 — Prerequisites (quota)

### 4.1 Denormalize the student-safe payload onto the lesson

Today `getStudentLesson` reads the lesson doc, then `getStudentLessonView` reads it **again**, then queries `generatedContent`. Per lesson. A sync that needs 30 lessons' study guides costs 30 extra queries.

Add a JD-owned field to `lessons`:

```ts
// src/types/index.ts
/** Student-safe copy of the published study guide, denormalized at publish
 *  time so a class sync is one query. NEVER contains a marking guide. */
export interface StudentPayload {
  summary: string;
  questions: PracticeQuestion[];   // { number, question }
  topicTitle: string;              // resolved from topics/{topicId} at publish
  revision: number;                // = publishedAt of the publishing action
}
```

**Written in exactly two places**, both already holding the content:

- [src/app/api/lessons/[id]/publish/route.ts](../src/app/api/lessons/[id]/publish/route.ts) — on POST, alongside `status: "published"`; on DELETE (unpublish), set to `FieldValue.delete()`.
- A new `setStudentPayload(lessonId, payload)` in [src/lib/db/lessons.ts](../src/lib/db/lessons.ts), guarded by `assertWritable(JD.lessons)` like every other writer.

Build it through a single narrow function so the marking guide cannot be copied by accident:

```ts
// src/lib/db/lessons.ts
/** The ONLY constructor for StudentPayload. Takes the safe fields by name —
 *  spreading `content` here would leak the marking guide, so we never spread. */
export function toStudentPayload(
  content: GeneratedContent, topicTitle: string
): StudentPayload {
  return {
    summary: content.summary,
    questions: content.questions,
    topicTitle,
    revision: Date.now(),
  };
}
```

Rules impact: **none.** `lessons` is already `allow write: if false`; a new field needs no rule change. Index impact: **none** — no new query shape. [docs/firestore-indexes-to-append.md](firestore-indexes-to-append.md) stays accurate.

### 4.2 Backfill

`scripts/backfill-student-payload.ts`, following the existing script convention (inline Admin SDK init via `process.loadEnvFile`, per the `scripts-admin-init` pattern — do **not** import `server-only` modules):

- Page `lessons where status == "published"` in batches of 200.
- For each, `getGeneratedContent` + topic title, `toStudentPayload`, write.
- Idempotent: skip lessons that already have a payload unless `--force`.
- Dry-run by default; `--commit` to write. Report read/write counts so the quota cost is known before committing.

Plus a **bounded lazy fallback** in the sync bundle (§5.1): if a published lesson has no `studentPayload`, resolve it the old way and write it — but **at most 5 per request**, so a missed backfill degrades gracefully instead of stampeding.

### 4.3 Stop writing a view on every render

[src/app/(student)/student/lessons/[id]/page.tsx](../src/app/(student)/student/lessons/[id]/page.tsx) calls `recordLessonView` on **every** render, so a cached read still costs a Firestore write. Offline would turn this into a reconnect flood.

Move view recording to the client, deduplicated: **at most one view per lesson per student per UTC day**, tracked in IndexedDB. Delivered via the batch endpoint in §6. This cuts view writes by roughly an order of magnitude and is worth doing on its own.

---

## 5. Phase 1 — Student offline read

### 5.1 The class sync bundle — the core quota mechanism

One cached server function serves **every** student request in a class:

```ts
// src/lib/db/student-content.ts
export type SyncLesson = {
  lessonId: string;
  title: string;
  topicTitle: string;
  subjectId: string;
  subjectName: string;
  hasMaterial: boolean;
  hasStudyGuide: boolean;
  updatedAt: number;
  studyGuide: { summary: string; questions: PracticeQuestion[] } | null;
  file: { name: string; size: number; inline: boolean } | null;
};

/** Everything a class may read, in ONE Firestore query, cached 5 minutes and
 *  shared by every student in the class. Scoping is enforced INSIDE the cache
 *  (same discipline as getStudentLesson) and the key includes both ids. */
export function getClassSyncBundle(schoolId: string, classId: string) {
  return unstable_cache(
    async (): Promise<SyncLesson[]> => { /* ... */ },
    ["student-sync", schoolId, classId],
    { tags: [studentLessonsTag(classId)], revalidate: REVALIDATE_SECONDS }
  )();
}
```

Implementation: extend the `.select()` in [listVisibleLessonsForClass](../src/lib/db/lessons.ts#L64-L104) to add `studentPayload`, `updatedAt`, `fileName`, `fileSize`, `fileType`, `fileKey`. Join subject names from the existing `getSubjects(schoolId)`. `extractedText` stays **out** — 200 × up to 800 KB would blow Vercel memory.

**Cost: one Firestore query per class per five minutes, regardless of how many students sync or how often.** This is the single most important number in the design. It is achieved because the existing `studentLessonsTag(classId)` invalidation already fires on publish, unpublish, material toggle, edit, delete and file upload — so the cache is correct without a new invalidation path.

### 5.2 Three endpoints, all served from that one bundle

| Route | Returns | Firestore cost |
|---|---|---|
| `GET /api/student/sync` | **Index only** — everything except `studyGuide`. ~150 B/lesson, so ~30 KB at the 200-lesson cap. `ETag` = hash of the index; returns `304` when unchanged. | 0 extra (bundle cache) |
| `GET /api/student/lessons?ids=a,b,c` | `studyGuide` for up to **10** ids per call. Client asks only for lessons whose `updatedAt` differs from IndexedDB. | 0 extra (bundle cache) |
| `GET /api/student/lessons/[id]/material` | `extractedText` for one lesson. Own `unstable_cache`, key `["student-material", lessonId]`, tag `lessonViewTag(lessonId)`. | 1 read per lesson per 5 min, across all students |

All three: `getStudentSession()` → 401 if null; scope by `session.schoolId` + `session.classId`; `Cache-Control: private, no-store` (the device store is IndexedDB, not the HTTP cache — see §5.5).

Batching at 10 and ETag-ing the index are both for the 3G link, not for quota: each response stays small enough to complete on a flaky connection, and a resumed sync re-requests only what it still needs.

### 5.3 Sync as a resumable state machine

`src/lib/offline/sync.ts`, running in the client:

```
idle → index → payloads → materials → done
                  ↑            ↑
                  ╰── resume ──╯   (progress persisted after every batch)
```

1. `GET /api/student/sync` with `If-None-Match`. On `304`, jump to step 4.
2. Diff against IndexedDB: collect ids where local `updatedAt` ≠ remote, plus ids absent locally. Delete local lessons absent from the index (handles unpublish and delete).
3. Fetch payloads in batches of 10, **committing each batch to IndexedDB before requesting the next**. Progress after every batch, so a drop loses at most one batch.
4. Materials: lazily on first open, or all of them on explicit "Save all for offline". Sequential, never parallel — parallel requests on a saturated 3G link make every one of them slower.
5. Write `lastSyncAt` and `offlineGraceUntil` to the `meta` store.

Triggers, and **only** these: app open, `online` event, `visibilitychange` to visible when `lastSyncAt` is older than 5 minutes, explicit button, and Background Sync (`SyncManager`, tag `jd-sync`) where available. **No interval, no listener** — the no-polling rule in CLAUDE.md is not relaxed.

### 5.4 IndexedDB schema

DB `jdsmartlearn`, version 1. Hand-rolled promise wrapper in `src/lib/offline/db.ts` (~60 lines) rather than the `idb` package — this codebase keeps its dependency list short deliberately, and we need only get/put/delete/getAll/cursor.

| Store | Key | Value |
|---|---|---|
| `meta` | string | `{ studentId, classId, lastSyncAt, offlineGraceUntil, etag, syncState }` |
| `lessons` | `lessonId` | `SyncLesson` + `savedAt` |
| `materials` | `lessonId` | `{ lessonId, text, revision, savedAt, bytes }` |
| `outbox` | auto | `{ id, kind: "view", lessonId, dayKey, count, batchId, state }` |

Storage discipline: request `navigator.storage.persist()` on first sync; check `estimate()` before writing materials; cap `materials` at **25 MB** with LRU eviction by `savedAt`; cap the SW file cache at **50 MB** (§8). On `QuotaExceededError`, evict and retry once, then surface *"Your phone is out of space for saved lessons."*

### 5.5 Keeping marking guides off student devices — structurally

Four independent barriers, so no single mistake leaks a guide:

1. `StudentPayload` is built **only** by `toStudentPayload`, which names its fields rather than spreading `GeneratedContent` (§4.1).
2. The sync bundle is derived from `lessons`, never from `generatedContent`. `getGeneratedContent` keeps its single caller: the tutor review page.
3. The `SyncLesson` type has no field a guide could occupy — the same type-level guarantee `StudentLessonDetail` already provides.
4. The service worker holds an explicit **deny-list**: never cache `/tutor/**`, `/api/lessons/**` (except the `file` GET in Phase 4), or any `/api/**` non-GET. Enforced in `fetch` before any cache write.

A review checklist item for §11: grep that `generatedContent` appears in no file reachable from a student route.

### 5.6 App shell and routing

Add `src/app/(student)/student/offline/page.tsx` — a `"use client"` page that is the offline renderer. Its HTML contains **no student data**, so caching it is safe on a shared phone.

The service worker serves this shell for any failed or cache-first `/student/*` navigation. The shell reads `window.location.pathname`, parses the lesson id, and renders from IndexedDB using the same view components as the server path:

- `src/components/student/DashboardView.tsx`
- `src/components/student/LessonReaderView.tsx`

Both are client components taking a plain data prop. The server pages ([student/page.tsx](../src/app/(student)/student/page.tsx), [student/lessons/[id]/page.tsx](../src/app/(student)/student/lessons/[id]/page.tsx)) keep their existing auth + fetch and pass the data down; the components persist what they receive into IndexedDB on mount. One renderer, two data sources.

This sidesteps App Router RSC-payload caching, which would otherwise be the hard part: `?_rsc=` responses are build-id-keyed and **contain student data**, so caching them would be both brittle and a shared-phone leak. We cache only the data-free shell.

### 5.7 Offline lifetime, and why it improves security

Cached content is readable without a valid session — the client reads IndexedDB, not the cookie. That is unavoidable in any offline design, so it must be bounded and revocable.

- `STUDENT_OFFLINE_GRACE_DAYS`, default **7** (a school week). `offlineGraceUntil` is written at each successful sync. On shell boot, if `now > offlineGraceUntil`, **wipe `lessons` and `materials`** and show the re-sign-in state.
- **Revocation on reconnect.** Add `POST /api/student/session/refresh`, backed by a second cookie `jd_student_r` (httpOnly, `sameSite: "lax"`, 7 days, `{ studentId }`, jose HS256). It re-reads `students/{id}` and:
  - `isActive === false` → `401`, client **wipes the store** and signs out.
  - `classId` changed → reissue the 12h `jd_student` for the new class, and **wipe the store** (old class content must not persist).
  - otherwise → reissue the 12h JWT.
  - Cost: 1 read per student per 12h. A 40-student class ≈ 80 reads/day.
- **One student per device.** On sign-in, if `meta.studentId` differs from the authenticated student, delete the whole database first. This is what protects a shared phone, and it is why full encryption is not needed — a key derived from the access code would defeat the goal of reading without re-entering it.

Net effect: today a deactivated student keeps their `classId` scope for up to 12 hours with **no** revocation path ([src/lib/auth/student.ts:26-41](../src/lib/auth/student.ts#L26-L41)). After this change, the first moment of connectivity revokes them and wipes the device. Offline mode makes this **stronger**, not weaker.

Note the store holds lesson content and `studentId` references only — never a name. The app never fetches student names for the student surface, and `getStudentsInClass` remains unused. The minors'-data rule in CLAUDE.md is unaffected.

---

## 6. Phase 2 — The view queue

Offline views go to the `outbox` store, flushed via `POST /api/student/views`:

```jsonc
{ "batchId": "uuid-v4",
  "views": [ { "lessonId": "abc", "dayKey": "2026-07-26", "count": 3 } ] }  // ≤ 50
```

`recordLessonView` already uses a deterministic doc id `${lessonId}_${studentId}` with `merge: true` and `FieldValue.increment(1)` ([src/lib/db/lesson-views.ts](../src/lib/db/lesson-views.ts)), so re-reads update rather than append. But `increment` is **not idempotent under retry** — a flush that succeeds and whose response is lost would double-count.

Fix: store `lastBatchId` on the `lessonViews` doc and skip the increment when it matches, inside a `runTransaction`. Exactly-once for the common retry, and views are a soft metric so the residual risk is acceptable. Batch all writes for a flush into one `batch.commit()` (≤ 50 docs).

Client rules: mark entries `sending` before the request, clear only on `200`, revert to `pending` on failure with capped exponential backoff, and drop entries older than the grace window. Flush at most one merge per `lessonId` per flush.

---

## 7. Phase 3 — Tutor write queue

Generation stays online. What works offline:

| Action | Offline behaviour |
|---|---|
| Compose a lesson from pasted text | Queued as `create`; validated on the device against the same 200-character floor |
| Upload a file | **Not offline.** The picker is disabled with *"You'll need internet to upload a file."* |
| Edit title / material text | Queued as `patch` with `baseUpdatedAt` |
| Publish, publish/hide material, delete | Queued |
| Add a custom topic | **Not offline** — it writes to Firestore immediately, and the lesson needs a real topic id |
| Generate | **Not queueable** — needs Gemini |

**Files are text-only offline by decision.** Queuing a 10 MB blob on a mid-range Android is a real cost, and worse, extraction happens server-side — so a tutor would learn a PDF was an unreadable scan days later, when it finally uploaded. Pasted text validates instantly on the device. Better to refuse up front than to accept work we cannot check.

**Flushed work uploads itself** on reconnect. Failures surface in [`PendingUploads`](../src/components/tutor/PendingUploads.tsx) with the server's own message and a keep-or-discard choice, because a teacher who wrote a lesson deserves to know it didn't land.

**Never auto-generate after a flush.** Generation spends the daily cap and teacher review before publish is mandatory, so a flushed create lands as a draft and waits for the tutor. That is a product rule, not an omission.

Store: `jdsmartlearn-tutor`, separate from the student DB, namespaced by `uid`, wiped when a different tutor signs in, wiped on sign-out, TTL = the 5-day tutor session. Marking guides may live here — tutor-only content on the tutor's own device — but must not outlive the session. When the store *is* wiped with work still queued, [`TutorShell`](../src/components/tutor/TutorShell.tsx) says so; silently vanishing work would look like a successful upload.

The runner is **strictly sequential**, posts to the **same `/api/lessons/*` routes** as the online path (identical authorization and validation), treats 4xx as terminal and 5xx/network as retryable, and stops early on a retryable failure rather than burning the tutor's data on a dead link.

`assignedClasses` is deliberately read fresh per request ([src/lib/auth/tutor.ts](../src/lib/auth/tutor.ts)) so revocations apply instantly; it is **not** cached offline. A queued op for a revoked class fails on flush, which is correct.

### Two pre-existing gaps closed

`POST /api/lessons` did not validate that `topicId` belonged to the session's school (it is read straight into the AI prompt) and took `className` verbatim from the client form. Both are denormalized onto the lesson and would ride out to every student device — and an outbox that replays client-supplied values makes both more exploitable. The route now verifies the topic's `schoolId` and derives `className` from `classes/{classId}`.

### One tradeoff worth knowing

Offline composing needs the class/subject/topic pickers, which are server-rendered into `/tutor/lessons/new`. So the service worker now caches **`/tutor` and `/tutor/lessons/new`** (network-first, cache as fallback). Those pages carry the tutor's class and topic names, so a shared phone could show them to the next person before they sign in. That is class metadata — not student data, not a marking guide — and it is wiped on sign-out and on tutor change.

**`/tutor/lessons/[id]` stays network-only.** It renders the marking guide.

---

## 8. Phase 4 — Files offline

Cache buckets, all versioned by deployment id:

| Cache | Contents | Strategy |
|---|---|---|
| `jd-shell-v{BUILD}` | `/student/offline`, `/student/sign-in`, `manifest.webmanifest`, `icon.svg` | Cache-first |
| `jd-static-v{BUILD}` | `/_next/static/**` (immutable) | Cache-first, never revalidate |
| `jd-files-v1` | `GET /api/lessons/*/file` responses | Cache-first, **explicit opt-in only** |

Files are opt-in per lesson ("Save it for offline") because a 10 MB PDF on a cheap Android is a real cost the student should choose. Bucket capped at 50 MB with LRU eviction, never evicting the lesson being read.

The bytes live in the Cache API; the `files` IndexedDB store (schema v2) is the index over them, because the Cache API records no save time and LRU would otherwise be impossible. [`isFileSaved()`](../src/lib/offline/files.ts) checks **both** — a row without bytes means the browser evicted them, and the link must not render. Saving goes through the same authenticated route as any other request, so class scoping and the material-publish gate still apply: a student cannot save a file they may not read.

Invalidation rides on the sync plan: a lesson in `remove` or `staleMaterials` has its saved file dropped, so a withdrawn or edited lesson cannot keep serving an old PDF.

The file route currently sends `Cache-Control: private, max-age=3600` ([src/app/api/lessons/[id]/file/route.ts:78](../src/app/api/lessons/[id]/file/route.ts#L78)). A service worker is a private cache so storing it is legitimate, but we manage lifetime in the SW rather than relying on that header. Text remains the student-facing default on slow networks, per CLAUDE.md.

### Service worker delivery

Serve from a route handler `src/app/sw.js/route.ts` rather than adding build tooling:

- `Content-Type: application/javascript`, `Service-Worker-Allowed: /`, `Cache-Control: no-cache` so updates are picked up.
- Version constant from `process.env.VERCEL_DEPLOYMENT_ID`, falling back to the `package.json` version, injected at request time.

Deliberately **not** using `next-pwa` (unmaintained) or Serwist. The needed surface — three caches, one navigation fallback, one deny-list, one sync tag — is well under 200 lines, and Workbox's routing abstractions would obscure the deny-list that keeps marking guides out of the cache. That is the one thing here that must be auditable at a glance.

Update behaviour: install the new SW but **activate on the next full navigation** — no `skipWaiting()` + `clients.claim()`. Forcing a reload on a student mid-read on a bad connection is hostile. Surface a quiet *"A new version is ready. It will load next time you open the app."*

### PWA manifest

`public/manifest.webmanifest` + `manifest` in the root [layout.tsx](../src/app/layout.tsx) metadata (which currently has no manifest, viewport, or icon entries beyond `icon.svg`). `display: "standalone"`, `start_url: "/student"`, `scope: "/"`, maskable 192/512 PNG icons, `theme_color` matching the brand header. Install prompt is not pushed — students on shared phones should not be nudged to install.

---

## 9. Interface writing

Per CLAUDE.md: active voice, sentence case, never name the system. **Never the word "cache" — say "saved on your phone."**

| State | Copy |
|---|---|
| Offline (thin bar, only when offline) | You're offline. Showing your saved lessons. |
| Dashboard freshness | Saved on your phone • updated 2 hours ago — **Update lessons** |
| Syncing | Saving your lessons… 12 of 30 |
| Lesson not saved, offline | This lesson isn't saved on your phone yet. Connect to the internet once to save it. |
| Grace expired | Sign in again to read your lessons. You'll need internet once. |
| Out of space | Your phone is out of space for saved lessons. Some older ones were removed. |
| File not saved, offline | The original file (*name*) isn't saved on your phone. You can still read the lesson text below. |
| Tutor composing offline | You're offline. You can still write this lesson. It will upload when you're back online, and you can create the study materials then. |
| Tutor submit button, offline | Save on my phone |
| Tutor queue waiting | 3 changes are saved on your phone — They will upload when you're back online. |
| Tutor queue uploading | Uploading 3 changes… This finishes on its own. You can keep working. |
| Tutor op failed | 1 change couldn't be uploaded — *{server message}* — **Try again** / **Discard it** |
| Tutor store wiped | Saved changes on this phone were cleared. This phone was last used by a different teacher, or the sign-in expired. |
| Stale offline edit | This lesson changed while you were offline. Open it to see the newer version. |
| New SW waiting | A new version is ready. It will load next time you open the app. |

A permanent connection indicator is noise — the bar appears only when offline.

---

## 10. Files

**New**
```
src/lib/offline/db.ts                  IndexedDB wrapper (zero dependencies)
src/lib/offline/merge.ts               pure diff/merge + grouping (tested)
src/lib/offline/sync.ts                resumable sync state machine
src/lib/offline/outbox.ts              read-receipt queue + flush
src/lib/offline/boot.ts                app-open / reconnect orchestration
src/lib/offline/wipe.ts                clears IndexedDB + SW caches
src/lib/offline/config.ts              batch sizes both sides share
src/lib/offline/files.ts               opt-in saved original files (Phase 4)
src/lib/offline/collapse.ts            pure op collapsing - replaces chaining (tested)
src/lib/offline/tutor-db.ts            tutor store: uid-scoped, TTL'd, wipeable
src/lib/offline/tutor-outbox.ts        sequential runner, terminal vs retryable
src/components/tutor/TutorShell.tsx
src/components/tutor/PendingUploads.tsx
src/components/student/StudentShell.tsx
src/components/student/OfflineBar.tsx
src/components/student/DashboardView.tsx
src/components/student/LessonReaderView.tsx
src/components/ServiceWorkerRegistrar.tsx
src/app/sw.js/route.ts
src/app/(student)/student/offline/page.tsx     the data-free app shell
src/app/api/student/sync/route.ts
src/app/api/student/lessons/route.ts
src/app/api/student/lessons/[id]/material/route.ts
src/app/api/student/views/route.ts
src/app/api/student/session/refresh/route.ts
public/manifest.webmanifest
scripts/backfill-student-payload.ts
scripts/test-offline.ts
```

**Modified**
```
CLAUDE.md                              Offline rules section; offline removed from
                                       the out-of-scope list
src/types/index.ts                     StudentPayload, SyncLesson, SyncIndexEntry
src/lib/db/lessons.ts                  toStudentPayload / setStudentPayload /
                                       clearStudentPayload; widened .select();
                                       getStudentLessonView now takes a Lesson
src/lib/db/student-content.ts          getClassSyncBundle + index/guide/material
                                       slices; getPublishedLessonsBySubject removed
src/lib/db/lesson-views.ts             recordLessonViewBatch with lastBatchId;
                                       countLessonReaders now schoolId-scoped
src/lib/auth/student.ts                refresh cookie + refreshStudentSession()
src/app/api/lessons/[id]/publish/route.ts   writes / clears studentPayload;
                                       409 on a stale offline publish
src/app/api/lessons/[id]/route.ts      409 on a stale offline patch
src/app/api/lessons/route.ts           validates topicId school, derives className,
                                       optional publishMaterial flag
src/app/sw.js/route.ts                 caches /tutor and /tutor/lessons/new;
                                       /tutor/lessons/[id] stays network-only
src/app/layout.tsx                     manifest, viewport, SW registrar
src/app/(student)/layout.tsx           mounts StudentShell; sign-out wipes device
src/app/(tutor)/layout.tsx             mounts TutorShell; sign-out wipes drafts
src/app/(tutor)/tutor/lessons/new/NewLessonForm.tsx   offline mode: text only,
                                       queues on submit, keeps work if the link dies
src/components/student/LessonReaderView.tsx   file-saved gating + save affordance
src/app/(student)/student/page.tsx     renders via DashboardView
src/app/(student)/student/lessons/[id]/page.tsx  renders via LessonReaderView; the
                                       per-render Firestore write is gone
src/app/(student)/student/sign-in/page.tsx      wipes on arrival; ?expired=1 notice
src/components/SignOutButton.tsx       optional wipeOffline
package.json                           test:offline, backfill:payload
docs/ARCHITECTURE.md, README.md        corrected the stale "no file storage" claims
.env.example                           STUDENT_OFFLINE_GRACE_DAYS
```

New env var: `STUDENT_OFFLINE_GRACE_DAYS` (default `7`, capped at 30), server-only. No new secret, nothing `NEXT_PUBLIC_`. **No new npm dependency.**

---

## 11. Verification

### Automated

```
npm run typecheck     # clean
npm run test:offline  # 25 tests, all passing
npm run build         # clean
```

`scripts/test-offline.ts` covers the three places a bug is expensive: `planSync` (getting it wrong serves a lesson the tutor withdrew), `evictionPlan` (getting it wrong deletes the lesson being read), and `collapse` (getting it wrong loses a teacher's work, or forces the dependency graph back). It runs on **`node:test` via the existing `tsx`**, so the safety net cost no new dependency. (The plan floated `vitest`; it turned out to be unnecessary.)

Covered — sync: a never-seen guide is fetched; an unchanged lesson is left alone; a moved `updatedAt` re-fetches and invalidates the material; a lesson absent from the index is removed; a whole-class move removes all and fetches all; eviction drops least-recently-saved first, only as much as needed, and never a protected lesson; `dayKey` agrees with the server across the WAT/UTC boundary.

Covered — collapse: a patch folds into its create; repeated edits keep the last value; a material publish folds into the create; create-then-delete sends nothing; deleting a server lesson discards its earlier edits; merged patches keep the *oldest* baseline so the staleness check stays honest; first-seen order across lessons is preserved; independent lessons stay independent.

**`npm run lint` does not run** — the repo has no ESLint config, so `next lint` drops into an interactive setup prompt. Pre-existing, not introduced here, and left alone deliberately: choosing a lint config is a repo-wide decision.

### Manual, in Chrome DevTools

Not yet run — these need a real device, a seeded student and a throttled link.

1. **Cold offline load.** Sign in as the seeded CAPSTONE student, let sync finish, Application → Service Workers → *Offline*, hard-reload `/student`. Dashboard renders. Open a lesson — summary and questions render. Open a never-visited lesson — the "not saved yet" state, not a crash.
2. **Quota proof.** Firebase console → Firestore usage. Sync from three browser profiles as three students in one class within five minutes. Read count must rise by **one query**, not three.
3. **Marking-guide audit.** Application → IndexedDB → `jdsmartlearn`; search every store for a `keyPoints` key. Must be absent. Then Cache Storage: no `/tutor/**` or `/api/lessons/**` entry.
4. **Shared phone.** Sign in as student A, sync, sign out, sign in as student B. `jdsmartlearn` must contain none of A's lessons.
5. **Revocation.** With the device offline and populated, set `students/{id}.isActive = false` in the console. Go online. The store wipes and the app returns to sign-in.
6. **Grace expiry.** Set `STUDENT_OFFLINE_GRACE_DAYS=0`, sync, go offline, reload. Store wipes, re-sign-in state shows.
7. **3G resumability.** Network → *Slow 3G*. Start a sync, kill the network mid-way, restore it. Sync resumes from the last committed batch, not from zero.
8. **Publish invalidation.** Publish a lesson as a tutor, sync as a student → it appears. Unpublish, sync → it disappears from the device.
9. **JS budget.** `npm run build`; the student route's First Load JS delta must be ≤ 30 KB gzipped. **Measured after the ilumo brand system landed: `/student` 112 kB, `/student/lessons/[id]` 113 kB and `/student/offline` 115 kB against a 102 kB shared baseline — a 10–13 kB delta, comfortably inside budget.** The design primitives in `src/components/ui` cost about 1 kB per student route because they carry no hooks and no `"use client"`. The display font is not JS and does not count here: it is one 32 KB woff2, served from `/_next/static/media`, cached by the service worker after first visit.
10. **Saved file.** Open a lesson with a PDF, tap "Save it for offline", go offline, reopen → the link works. Then unpublish the material as a tutor, sync → the saved file is gone.
11. **Offline file not saved.** With a PDF lesson synced but the file *not* saved, go offline and open it → the explanation, not a download link. (This is the Phase 1 defect Phase 4 fixed; it must not regress.)
12. **Tutor offline compose.** Visit `/tutor/lessons/new` online once, go offline, reload it → the form renders with pickers. The file button is disabled. Paste 300 characters, tap "Save on my phone" → `/tutor` shows it queued. Go online → it uploads and appears as a draft, **not generated**.
13. **Tutor collapse.** Offline, create a lesson then edit its title twice. Go online and watch the Network tab: exactly **one** `POST /api/lessons`, no `PATCH`.
14. **Stale offline edit.** Queue an edit offline; change the same lesson's title in another browser as an admin; go online → the queued op fails with "This lesson changed while you were offline" and a discard action.
15. **Tutor marking-guide audit.** Application → Cache Storage: there must be **no** `/tutor/lessons/{id}` entry (only `/tutor` and `/tutor/lessons/new`).
16. **Tutor sign-out.** Queue work offline, go online, sign out mid-flush → `jdsmartlearn-tutor` is gone.

### Still to do before this ships
- Run `npm run backfill:payload <schoolId>` (dry run first). Until then the sync route repairs up to 5 pre-existing published lessons per request, which works but is a safety net, not a migration.
- Add maskable PNG icons at 192px and 512px to `public/` and reference them in `manifest.webmanifest`. It currently points at the existing SVGs, which installs but gives a poorer home-screen icon.
- Walk the manual checklist above on a real mid-range Android.
- Decide whether the tutor review screen ([`ReviewLesson.tsx`](../src/app/(tutor)/tutor/lessons/[id]/ReviewLesson.tsx)) should queue its edits too. The outbox supports `patch` and `publish` ops, but that screen still posts directly — and since `/tutor/lessons/[id]` is deliberately never cached, a tutor cannot reach it offline anyway. Wiring it up only helps the case where the link dies *mid-review*, which is worth doing but is not the same feature.

### Definition of done ([CLAUDE.md](../CLAUDE.md))
- [x] Authorization server-side — every sync route calls `getStudentSession()` and scopes by `schoolId` + `classId`; the device store holds only post-authorization projections
- [x] Query filtered by `schoolId` and limited — one query, the existing `listVisibleLessonsForClass` shape, `limit(200)`
- [x] No personal data in any AI payload — generation untouched
- [x] Works at 360px
- [x] Loading, empty, and error states written — plus six new offline states (§9)
- [x] No secret exposed to the client — SW and IndexedDB code carry none
- [x] No write to a ResultPeak-owned collection — writes go to `lessons.studentPayload` and `lessonViews`, both JD-owned, both through `assertWritable`
- [x] No `firebase deploy`, no new composite index, no client Firestore access, no `onSnapshot`, no polling, no Firebase Storage

---

## 12. Phase 5: Assessment (added 2026-08-10)

Assignments, submissions and marking extend the design above. They add no new
mechanism: the same stores, the same on-demand triggers, the same queue.

### Student

| Store | Holds | Wiped by |
|---|---|---|
| `assignments` | the list, plus instructions for unanswered work | `destroy()` |
| `submissions` | this student's own answers and released marks | `destroy()` |
| `drafts` | answers still being written | `destroy()` |
| `submissionOutbox` | finished answers waiting for a network | `destroy()` |

Database version 3. `wipeDevice()` deletes the whole database, so the four new
stores were covered by the shared-phone path the moment they existed. No change
was needed there, and none should be added.

`syncAssignments()` runs inside `boot.ts`, after the three security steps, never
on its own schedule. One request, ETag'd, deletes what the server no longer
lists before writing what it does: a tutor switching an assignment off takes it
off the phone, exactly as a withdrawn lesson is removed.

Flush order is deliberate. Read receipts first, submissions second. A receipt is
a soft metric that may be dropped to protect the quota; a submission is a
child's homework and must not be starved behind a queue of receipts failing.

**Text only in the queue.** A submission with attachments requires a connection,
and the form says so before the student starts writing. Holding a multi-megabyte
photo in IndexedDB until reconnect would blow the device budget and put an
unmanaged copy of a child's work outside the grace window and the wipe path.

A rejected submission is never dropped silently. The 4xx message is stored on
the queued row and shown on the assignments list with a way to clear it, the
same contract the tutor queue has always had.

### Tutor

Marking joins the EXISTING outbox as a `mark` op rather than starting a second
queue: same store, same collapse pass, same sequential flush, same
4xx-is-terminal rule, same `PendingUploads` surface. Collapsing follows the patch
rule, last values winning and the oldest `baseUpdatedAt` surviving, so a mark
queued at home on Sunday cannot clobber one saved on Monday. Five tests cover it.

### What tutors deliberately cannot do offline

**Open the submissions page.** `/tutor/assignments/[id]/submissions` renders the
marking guide, so it is network-only, exactly like `/tutor/lessons/[id]` and
`/tutor/sign-ins`. Caching submissions for offline viewing would mean caching
the page that displays them, and there is no version of that which keeps marking
guides off the device.

So the split is: a tutor marks offline only from a page they already have open
when the signal drops, and their marks queue and send on reconnect. Opening the
list fresh needs a connection. This was a choice between two rules in CLAUDE.md,
and the marking-guide rule wins.

**Setting an assignment** is online-only too. A queued assignment cannot
announce itself to a class, and a due date set offline on Monday may already have
passed when it uploads on Thursday. Setting work is a scheduled act; writing a
lesson is not.
