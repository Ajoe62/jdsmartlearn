# School branding

How a school's own name, crest and colour reach the top of JDSmartLearn, and why
the obvious version of each step is wrong.

The goal is stated as a feeling: a child, a teacher or an admin opening this
product from their school's website should believe the school gave it to them,
not that the school linked them out to somebody else's software. Every decision
below is measured against that, and against the constraints in CLAUDE.md that do
not move for it.

**Status: all four phases shipped 2026-08-27.** Identity, the crest, per-school
colour and the per-school install are live. Build notes, including the places
this document turned out to be wrong, are in section 9.

Related: `docs/ilumo-brand.md` (the product brand this layers on top of),
`docs/OFFLINE-FIRST.md` (why the header is currently data-free),
`docs/resultpeak-school-branding-prompt.md` (the ResultPeak side).

---

## 0. What exists today, and what does not

Read this before designing anything, because three of the four things you would
reach for are absent.

| Thing | Where it is | State |
|---|---|---|
| School **name** | `schools/{id}.name` | Exists. Read-only. Already read by `getSchool()` and `getSchoolDirectory()`. |
| School **crest** | nowhere | Does not exist in the shared project. |
| School **colour** | nowhere | Does not exist. |
| School **slug** | derived | `schoolSlug(name)` in `src/lib/db/resultpeak.ts` computes it from the name at read time. Not stored, not stable across a rename. |

`schools` is ResultPeak-owned. **This repo never writes it** (CLAUDE.md). So the
crest and the colour have to live in a JDSmartLearn-owned collection, and
`jdSchoolSettings` already exists, is already admin-gated, and already has a form
at `/tutor/settings`.

### The brand-architecture change this implies

`docs/ilumo-brand.md` section 1 currently says:

> **Endorsed.** Each product keeps its own name and leads with it.

That is what produces the effect being complained about. Putting the school first
is a **co-brand tier change**, from *endorsed* to *school-branded, powered by*:

```
Capstone Academy          <- what a user reads first, on every signed-in screen
JDSmartLearn              <- small, below or in the footer
an Ilumotech product      <- footer and front door only
```

`docs/ilumo-brand.md` is the source of truth **for two repositories**. Amend
section 1 there first and copy the file to ResultPeak; do not encode the new
hierarchy in components while the spec still says the old thing. A palette or an
architecture that drifts between the two products reads as a bug rather than a
choice — that is the standing rule at the bottom of
`docs/resultpeak-branding-prompt.md`.

---

## 1. The three tiers

Naming the tiers is what stops this becoming a theming free-for-all that fails
contrast at one school in five.

**Tier 1 — Identity. Always on, no configuration.**
School name and a crest in the header, the school name in the page title, the
school name on the sign-in screen. Works for every school on the day it ships,
because of the monogram in section 3.

**Tier 2 — Colour. Opt-in, constrained, three tokens.**
One school colour, driving a header band and a quiet rule. It never becomes the
action colour and never touches a status colour. Section 5.

**Tier 3 — Entry. The part that actually fixes the "third-party" feeling.**
School-scoped URLs, a school front door, no school picker once the school is
known, and a school-named install on the home screen. Section 6.

Ship them in that order. Tier 1 alone changes the perception more than tiers 2
and 3 combined, and it has no dependency on anything.

---

## 2. Where branding lives

`jdSchoolSettings/{schoolId}.branding` — JDSmartLearn-owned, one document per
school, written only by a school admin through `/tutor/settings`.

```ts
export interface SchoolBranding {
  /** R2 key: `branding/{schoolId}/crest-{hash}.png`. Null until uploaded. */
  logoKey: string | null;
  /** Epoch ms. The cache-buster in the crest URL - see section 4. */
  logoUpdatedAt: number | null;
  /** "Capstone" for a 360px header. Falls back to the ResultPeak name. */
  shortName: string | null;
  /** The ONE school colour, validated at save time. Null means indigo. */
  colorHex: string | null;
  /** Optional, and shown on the school front door only. Never in the header. */
  motto: string | null;
  updatedAt: number;
  updatedBy: string;
}
```

Nested under one `branding` key rather than spread across the settings
document, so the resolver in section 3 reads and projects exactly one field.

**This is not a mirror of a ResultPeak field, and the distinction matters.** The
"do not copy it into a JD collection" rule in CLAUDE.md exists because a copy
drifts the first time somebody edits the original. There is no original here —
ResultPeak stores no crest at all. The moment ResultPeak owns one, the resolver
below prefers it and this field becomes the fallback, in one function, without
touching a call site.

---

## 3. One resolver, and the caching trap

Everything reads school branding through a single function. This is the same
shape as `getCurrentTermSession()` in `src/lib/db/school-settings.ts`: one read,
documented as the only read, so the ResultPeak handover changes one file.

```ts
// src/lib/branding/school.ts
export interface SchoolBrand {
  schoolId: string;
  name: string;         // ResultPeak's, verbatim
  shortName: string;    // shortName ?? name
  initials: string;     // the monogram fallback
  crestUrl: string | null;   // phase 2
  slug: string;
  // phase 3 adds: colorHex, and a headerFg computed from it - section 5
}

/** Null for a school that does not exist or is inactive. */
export function getSchoolBrand(schoolId: string): Promise<SchoolBrand | null> { ... }
```

### The trap

`src/lib/db/resultpeak.ts` carries an explicit, load-bearing warning:
`getSchool()` is **deliberately not cached**, because three callers re-read
`assessmentTypes` precisely because it can change under them, and a cache there
would put a staleness window in front of a decision about a real child's marks.

So `getSchoolBrand()` must **not** call `getSchool()`, and must **not** cache a
school document. It reads the two fields it needs directly and caches only the
projection — exactly the pattern `getSubjectAllocationEnforced()` already
demonstrates in that file, and for exactly the stated reason: nothing can later
reach into a cached school object and pick up a stale `assessmentTypes`.

```ts
unstable_cache(
  async () => {
    const [school, settings] = await Promise.all([
      adminDb.doc(`${RP.schools}/${schoolId}`).get(),
      adminDb.doc(`${JD.schoolSettings}/${schoolId}`).get(),
    ]);
    // ...project to the six named fields of SchoolBrand, and return THAT.
  },
  ["school-brand", schoolId],
  { revalidate: 900 }
);
```

**There is no field mask here, and reaching for one is a mistake worth naming.**
`select()` is a method on a Firestore *Query*, not on a `DocumentReference`, so
the tidy-looking `doc(...).select("name").get()` does not compile. It could be
written as a documentId query, but it would buy nothing that matters: Firestore
bills per document either way, and **the field mask was never the safety
property**. The invariant is that only the six named fields of `SchoolBrand`
cross the `unstable_cache` boundary, so no cached object anywhere in the process
holds `assessmentTypes` for a future caller to find. Project on the way out and
the invariant holds however the document was fetched.

Two reads per school per 15 minutes, however many people are signed in. A crest
changes about never, and a school admin who has just uploaded one will tolerate a
quarter hour — but say so in the settings form, because silently-stale is how an
admin uploads the same file four times.

### Resolution order

1. `jdSchoolSettings/{id}.branding` — today's source.
2. `schools/{id}.branding` — preferred the moment ResultPeak ships it.
3. **Derived default.** Never blank.

### The monogram is the most important line in this document

Most schools will not have uploaded anything on day one. If the header is empty
until an admin acts, the feature ships as broken for every school at once.

So the default is a **two-letter monogram** derived from the school name — first
letters of the first two significant words, skipping "The", "School", "Academy",
"College", "International" — set in the display face, reversed out of the school
colour, or indigo when there isn't one. `CAPSTONE ACADEMY` becomes `CA`;
`THE GOOD SHEPHERD SCHOOL` becomes `GS`.

This is what makes *every* school look bespoke from the first sign-in, before any
admin does anything at all. A school that later uploads a crest is an
improvement, not a rescue.

---

## 4. Serving the crest

New route: `GET /api/schools/[schoolId]/logo`.

**It is deliberately unauthenticated, and that is a documented exception.**
CLAUDE.md says files are served only via authenticated routes, never a public
bucket URL. That rule is about lesson material and marking guides. This route
cannot require a session, because the screen that needs it most is the sign-in
screen, where nobody has one yet.

Bound the exception so the next reader does not treat it as a hole:

- Serves **only** the `logoKey` recorded on that school's own branding document.
  The URL names a school, never a storage key — an arbitrary key in the path is
  how this becomes a read primitive for the whole bucket.
- 404 for a school that is missing, inactive, or has no crest.
- Response is `image/png`, `image/jpeg` or `image/svg+xml` only, from a
  server-side allowlist, never from the request.
- `Cache-Control: public, max-age=31536000, immutable`, with `?v={logoUpdatedAt}`
  supplying freshness. Never re-fetched, and a new upload is a new URL.
- Cap at upload: **150 KB**, square, at least 512px for the PWA icon in section 6.

What the response contains is a crest the school prints on a uniform and puts on
its own gate. No student data, no marking guide, no enumeration — you need a
20-character Firestore id to ask, and the answer is a public logo.

Record this exception in CLAUDE.md when you implement it. An undocumented
deviation from a "never" is worse than the deviation.

**SVG:** serve it with `Content-Security-Policy: default-src 'none'` and
`X-Content-Type-Options: nosniff`, or convert to PNG at upload. An SVG is a
document that can carry script, and an admin who uploads one their designer sent
them has not audited it.

### Service worker

Add the crest to the cacheable set. It is safe for the student device store by
the same argument as a scheme of work: it has no marking guide and no field one
could occupy. Add an allowance for `/api/schools/{id}/logo` to `denied()` in
`src/app/sw.js/route.ts` — narrowly, matching only that shape, in the style of
the existing `/api/lessons/[id]/file` carve-out.

---

## 5. Colour, without breaking the contrast guarantees

This is the part that will go wrong if it is built the way it is usually asked
for. `docs/ilumo-brand.md` enforces contrast with `scripts/check-contrast.ts`,
sets `lineInput` unusually dark to clear WCAG 1.4.11 at 3:1, and has a rule
labelled *the one everyone breaks first*: fill-only colours never carry text. A
free-form hex from a school admin drives straight through all of it — the first
school with a yellow crest gets white text on yellow.

**The school colour drives exactly three tokens.**

| Token | Use |
|---|---|
| `--school-bg` | The header band, and the crest plate behind a monogram. |
| `--school-fg` | Text and the crest on that band. **Computed, never chosen.** |
| `--school-quiet` | A tint, at ~8% alpha, for a rule under the header. Fill only. |

`--school-fg` is white or `ink`, whichever scores higher against `--school-bg` by
relative luminance. If **neither** reaches 4.5:1, the save is refused with the
measured ratio and the school keeps indigo. Do not silently darken their colour:
a school whose colour came out visibly wrong deserves to be told, not corrected.

**Three things the school colour never touches, and the reasons are already
written down elsewhere in this repo:**

- **The action colour.** Buttons stay `brand` indigo. The spec's rule that only
  one thing per screen wears solid blue is what tells a teacher what to do next;
  making it per-school makes that signal unlearnable for anyone who works at two
  schools, and makes its contrast a lottery.
- **Status colours.** `warn`, `danger`, `success` do not move. The spec already
  says warning and danger sit outside the logo palette on purpose, because a
  warning that borrowed a brand colour stops reading as a warning. That holds
  harder when the borrowed colour is a school's.
- **Anything printed.** `logo-mono.svg` and the monochrome path stay as they are.

**Delivery: CSS custom properties on `<html>`, set server-side.** The layout
resolves the brand and emits three variables in a `style` attribute. No client
component, no per-school stylesheet, no runtime theming library — the student
route budget is 30 KB gzipped and this costs nothing against it.

**Validation lives in one function, called twice.** Write
`assertBrandColour(hex): { fg, ratio } | Refusal` as a pure module with no
imports, in the spirit of `src/lib/auth/claims.ts`: the settings route calls it
before writing, and `scripts/check-contrast.ts` calls the same function over
every school's stored colour in CI. Two copies of a contrast test is how one of
them ends up weaker — that is precisely the 2026-08-12 rules incident recorded in
`docs/firestore-rules-to-append.md`.

---

## 6. Entry — the actual fix for "they see the option to change school"

### What is really happening

`src/app/s/[slug]/route.ts` line 19 redirects **every** visitor to
`/student/sign-in`. A teacher who clicks the link on their school's website lands
on the child's form, which renders the "Change school" link in `SignInForm.tsx`.
The tutor sign-in itself has no school picker and never has — staff `schoolId`
comes from custom claims and is not selectable.

So this is not a link to hide. It is a front door that does not exist.

### 6a. Make `/s/{slug}` a school front door

`/s/{slug}` sets the school cookie and renders a **branded school page**, rather
than redirecting into the student form:

- The crest, large. The school name as the `<h1>`. The motto under it.
- Two doors, both already scoped to this school: *I'm a student* →
  `/student/sign-in`, *I'm a teacher or admin* → `/tutor/sign-in`.
- *Results and report cards* → `resultPeakSchoolUrl(slug)`. Same link that exists
  today, framed as the school's own second service instead of the current
  "More from Ilumotech" card. **This single wording change does more for the
  stated problem than anything else on the page.**
- `JDSmartLearn · an Ilumotech product`, once, small, at the bottom.

Keep the existing behaviour for an unknown or ambiguous slug: fall through to the
picker rather than fail. A child mistyping a link should still land somewhere
they can sign in.

**Also accept the raw id at `/s/{schoolId}`.** The slug is derived from the name
and is not stable across a rename, so the link a school prints on a board today
breaks silently the day an admin fixes a typo in their own name. Matching the id
as well costs four lines and removes that failure until ResultPeak owns a stored
slug.

### 6b. Pinned versus remembered

The cookie currently means one thing. It has to mean two:

- **Remembered** — the child chose this school from the picker. "Change school"
  stays available; they may have chosen wrong.
- **Pinned** — they arrived through the school's own link. **No picker, no
  "Change school" link, anywhere.**

Add `jd_school_pinned`, set only by `/s/[slug]`, never by the picker. Then in
`SignInForm.tsx`, render the school as plain text with no link when pinned.

**Keep `/student/sign-in?school=change` working.** A child who genuinely
transfers, or a phone handed between two schools, must not be stranded. Stop
advertising the escape hatch; do not remove it.

### 6c. Brand the staff sign-in, and one rule that must not be broken

The tutor sign-in can read the pinned school and render its crest, which is what
stops the staff door feeling like a different company's product.

**But the cookie may only decorate pre-authentication screens. Every signed-in
surface reads `schoolId` from the session, never from the cookie.**

An unauthenticated visitor controls that cookie completely — anyone can visit
`/s/anything`. Pre-auth that is harmless: it shows a public school name and
crest. Post-auth it would be a trust disaster, showing a teacher the wrong
school's crest above their own class's data. `getTutorSession()` and
`getStudentSession()` already carry `schoolId`; that is the only input to a
signed-in header.

### 6d. The unscoped front door

Keep `/` for people who arrive with no school — support, a first-time member of
staff, a demo. But when a school is pinned, redirect `/` to `/s/{slug}`, so a
bookmarked root does not silently drop back to the generic page.

### 6e. Install to the home screen

`public/manifest.webmanifest` is static, so an installed icon says
"JDSmartLearn" — the strongest third-party signal of the lot, and the one that
sits on the phone permanently.

Serve it from a route handler instead, at `src/app/manifest.webmanifest/route.ts`.
There is already a precedent in this repo: `src/app/sw.js/route.ts` is served the
same way, for the same kind of reason. Read the pinned school and emit its
`name`, `short_name`, `theme_color` and icon; fall back to JDSmartLearn's when
unpinned.

**Be honest about the icon.** Android wants PNG at 192 and 512, maskable. This
repo takes no image-processing dependency and should not start. So: require a
square PNG of at least 512px at upload, use it directly, and keep JD's maskable
tile when a school has uploaded nothing or uploaded an SVG. A school that has
only a crest in SVG gets its **name** on the home screen and JD's icon, which is
most of the win.

---

## 7. Offline

The header is currently data-free on purpose. `AppHeader` says so, and
`src/app/(student)/student/offline/page.tsx` says it at length: the service
worker serves that one cached HTML document for any `/student/*` navigation it
cannot fetch, and it is shared by every student who ever uses the phone.

School branding is not personal data, so it does not breach that. But the cached
shell is school-agnostic HTML, so a **server-rendered** crest would be frozen at
whichever school was current when the shell was cached — a child who transfers
would see their old school's crest offline, indefinitely.

So:

- Store the resolved `SchoolBrand` in IndexedDB as part of the existing sync
  payload. **Fold it into `getClassSyncBundle`** — do not add a fetch. The rule
  is one Firestore query per class per revalidate window however many students
  sync, and a per-device branding request breaks it at exactly the moment a
  school is busiest.
- `StudentShell` re-applies the three CSS variables and the crest from IndexedDB
  on mount. A few hundred bytes, and it is the same "empty props, filled from the
  store" pattern the offline shell already uses for the shelf and announcements.
- **Wipe the crest when the school changes, not only when the student does.**
  `wipeDevice()` handles a different student; a transferring child keeps the same
  `studentId`. Compare `schoolId` on boot and drop the cached branding and the
  crest from the Cache API when it differs.

Never say "cache". If the crest has not arrived yet, show the monogram — not a
spinner and not a gap.

---

## 8. What must not change

- **No write to `schools`, ever.** The crest lives in `jdSchoolSettings`.
- **No school name in an AI payload.** CLAUDE.md forbids school names in
  generation prompts, and this work puts `school.name` within easy reach of code
  that is near the generation path. Nothing in `src/lib/ai/` gains a branding
  import.
- **No new runtime dependency.** No theming library, no colour package, no image
  processor. The luminance calculation is about eight lines.
- **The 30 KB student JS budget holds.** Server-rendered CSS variables, not a
  client theme provider. Run the existing budget check.
- **No `firebase deploy` from this repo.** Nothing here needs a rule or an index
  change: `jdSchoolSettings` is already covered, and `getSchoolBrand` adds no
  query that needs a composite index — both reads are document gets.

---

## 9. Order of work

**Phase 1 — SHIPPED 2026-08-27.**
`getSchoolBrand()` with the monogram fallback · school name and monogram in
`AppHeader` · school name in the page title · `/s/{slug}` becomes the school
front door · accept `/s/{schoolId}` · pinned versus remembered, and the picker
disappears when pinned.

Three notes from building it:

- **The monogram needed two word lists, not one.** Grammar (`the`, `and`, `of`)
  may never contribute an initial — "The Cedar School" must not be `TC`. Type
  words (`school`, `academy`, `college`) are initials of *last resort*, which is
  what keeps `CAPSTONE ACADEMY` at `CA` instead of a lonely `C`. One combined
  list gets one of those two cases wrong whichever way it is written.
- **The offline shell corrects itself, and needs no phase-2 work to be safe.**
  `wipeDevice()` already purges the Cache API and runs on every visit to the
  sign-in form, and `shellFirst()` re-fetches and re-caches the shell on each
  navigation. So a school change cannot leave a stale crest cached. The residual
  is cosmetic: a shell precached before anyone signed in carries the plain
  product lockup until the first navigation replaces it.
- **The staff sign-in lost its most third-party sentence.** "Use the same details
  as ResultPeak" was true and was also the line that told a teacher this was
  somebody else's system. It now reads "Teachers and admins at {school}. Use the
  email and password you already have."

**Phase 2 — SHIPPED.**
Upload in `/tutor/settings` (already admin-gated) · `/api/schools/[id]/logo` ·
service-worker allowance · IndexedDB and the offline path.

**Phase 3 — SHIPPED.**
`assertBrandColour()` · three tokens · settings UI showing the measured contrast
ratio · `check-contrast.ts` extended over stored colours.

**Phase 4 — SHIPPED.**
Dynamic manifest · per-school theme colour · PNG icon when one was uploaded.

**Then, separately:** the ResultPeak convergence in
`docs/resultpeak-school-branding-prompt.md`. It has no ordering relationship to
any phase above — JDSmartLearn shipped all four alone.

### What this document got wrong

Recorded rather than quietly corrected, because each one is a trap the next
reader would otherwise walk into.

- **The field mask does not exist.** Section 3 originally showed
  `doc(...).select("name").get()`. `select()` is a Query method, not a
  `DocumentReference` method, so that does not compile — and it was never the
  safety property. Only the projection crossing the cache boundary matters.
- **A bright colour is not an unreadable colour.** The design assumed a school
  yellow would be refused. It is accepted, at 11.93:1, because it carries **ink**
  — and so does the logo mint, at exactly the 11.21:1 the brand spec quotes.
  What actually fails is the *middle*: `#808080` at 4.32:1 and `#7D8471` at
  4.40:1 carry neither foreground. This is precisely why `bestForeground()` is
  not a lightness threshold, and the samples in `check-contrast.ts` now say so.
- **Branding does not belong inside `getClassSyncBundle`.** Section 7 said to
  fold it in. That bundle is cached per CLASS and tagged to lesson publishes;
  branding is per SCHOOL and changes on a different event. Folding it in would
  store the same crest once per class and make every crest edit invalidate every
  class's lesson index. The rule the guide was protecting — no extra device
  round-trip, no per-student fan-out — is satisfied by attaching the
  already-cached `getSchoolBrand()` to the sync **response** instead.
- **The monogram needs two word lists.** Grammar (`the`, `and`, `of`) may never
  contribute an initial; type words (`school`, `academy`) are initials of last
  resort. One list gets either "The Cedar School" or "Capstone Academy" wrong.
- **The offline shell needed less work than feared.** `wipeDevice()` already
  purges the Cache API on every visit to the sign-in form, and `shellFirst()`
  re-fetches the shell per navigation, so a school change cannot leave stale
  chrome. `applySchoolColour()` is the only client-side correction, and it sets
  three CSS variables rather than rewriting any markup.

### Things deliberately not done

- **No image processing.** No `sharp`, no resizing, no format conversion. A
  school supplies one square PNG of at least 512px and it becomes the install
  icon; anything else keeps the product tile, and the form says so plainly. A
  dependency whose only job is resizing a logo is not worth its supply chain.
- **The crest is not measured on read.** `logoIsIcon` is decided once at upload,
  while the bytes are in hand, so the manifest route never opens R2.
- **No dark-mode school palette.** One colour, one computed foreground. A
  school that wants a different colour at night is not a real request yet.

---

## 10. Definition of done

Beyond the standing checklist in CLAUDE.md:

- [ ] A school that has uploaded **nothing** still shows its own name and a
      monogram, on every signed-in screen
- [ ] `getSchoolBrand()` is the only read of school branding, and it caches a
      projection — no code path caches a school document
- [ ] Every signed-in surface takes `schoolId` from the session; the cookie
      decorates pre-auth screens only
- [ ] No school picker and no "Change school" link on a pinned device, in either
      audience; `?school=change` still works when typed
- [ ] A teacher arriving from the school's link reaches a branded school page
      with a staff door, never the student form
- [ ] A refused colour names the measured ratio and keeps indigo
- [ ] Offline: the crest renders from IndexedDB, and is dropped when `schoolId`
      changes
- [ ] The public logo route serves only a recorded key, only for an active
      school, and the exception is written into CLAUDE.md
- [ ] `docs/ilumo-brand.md` section 1 is amended and copied to ResultPeak
- [ ] `npm run check:brand` passes; student route JS still under 30 KB gzipped
- [ ] Works at 360px, with a long school name and a short one
