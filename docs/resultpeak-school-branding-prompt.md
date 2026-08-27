# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository.

**Status on the JDSmartLearn side: shipped, all four phases, 2026-08-27.**
JDSmartLearn now leads every screen with the school's name and crest. It holds
its own branding record in `jdSchoolSettings`, a collection it owns outright, so
nothing here is a blocker and nothing on the JDSmartLearn side breaks if this is
never done.

**But there are now two reasons to do it, and the second is the important one.**

1. *Coherence.* A child reads a lesson under their school's crest, taps through
   for their results, and lands on ResultPeak's chrome. They learn that only one
   of the two belongs to their school — which is worse than neither being
   branded, because the difference reads as a bug.
2. *Ownership, before a school uploads a crest twice.* Right now JDSmartLearn
   has the only crest upload. If ResultPeak builds a second one, a school
   maintains the same logo in two places and they drift the first time somebody
   edits one — which is exactly the failure CLAUDE.md's "never mirror it" rule
   exists to prevent. **Settle who owns the crest before either side builds more
   UI around it.** The recommendation and the reasoning are in task 0.

Related: `docs/SCHOOL-BRANDING.md` (the full JDSmartLearn design, including a
section on what that document itself got wrong) and
`docs/resultpeak-branding-prompt.md` (the shared ilumo system, sent earlier).

---

## Context

You are working in **ResultPeak**, a school exam and results platform, live on
Firebase project `resultpilot-ddf7c` (Spark plan), with a paying school running
real exams on it.

A sibling product, **JDSmartLearn** (an LMS), runs inside the *same* Firebase
project — same `projectId`, same Auth directory, same Firestore database. Both
are products of **Ilumotech**. ResultPeak owns the roster: `schools`, `classes`,
`students`, `studentAccess`, and the tutor and admin subcollections. JDSmartLearn
reads those and never writes them.

Schools in this market do not want to feel handed off to a third party. From
2026-08-27 JDSmartLearn puts the **school** first, the product second and the
Ilumotech endorsement third. This task brings ResultPeak onto the same footing,
and settles two pieces of shared data that are missing from the project
altogether.

## Task 0 — Decide who owns the crest, and say so out loud

Do this before writing code, and put the answer in a comment where both repos'
readers will find it.

Today `schools/{id}` carries **no crest, no colour, no motto and no stored
slug**. JDSmartLearn holds all four in `jdSchoolSettings/{schoolId}.branding`
because it may not write `schools`. That was correct as a starting point — there
was no original to mirror — but it is not where this should end up:

- ResultPeak owns `schools`. School admins already manage the school there.
- A crest is school identity, not LMS data.
- Two upload forms for one logo is a drift generator.

**Recommendation: ResultPeak takes ownership.** Tasks 1 and 2 add the fields,
JDSmartLearn starts preferring them, and JDSmartLearn's own upload becomes a
link into ResultPeak. If you disagree — for instance because ResultPeak has no
file storage and adding one is disproportionate — say so in the reply and
propose the alternative, but **do not build a second crest upload while
JDSmartLearn still has one.** One of the two has to be the source.

## Hard constraints

- **A paying school is running live exams in this project.** Nothing here may
  change exam behaviour, scoring, result computation, or an existing query.
- **`schools/{id}` is a live document.** Adding fields is fine; renaming,
  reshaping or removing anything is not. `name`, `subjects`, `gradingScale`,
  `isActive`, `assessmentTypes` and `subjectAllocation` are read by JDSmartLearn
  today and must keep their names, types and meanings.
- **Every new field is optional and absent-safe.** JDSmartLearn treats a missing
  `slug` and a missing `branding` as normal and so must you. No migration can be
  assumed to have run.
- **No new runtime dependency**, including an image processor. JDSmartLearn
  deliberately took none; see task 4.
- **Firebase Storage is forbidden in this project** — it would force the shared
  project onto Blaze. JDSmartLearn uses Cloudflare R2.
- Keep whatever accessibility behaviour already exists.

## The invariants

1. **The slug is stable and it is not the name.** Its entire purpose is to
   survive a school correcting a typo in its own name. Derive it once at
   creation, then never recompute it from the name again.
2. **The slug is unique across the project**, enforced by a write and not by a
   read-then-write. Two schools in this project already share a `name`.
3. **`branding` holds no personal data, ever.** A crest, a colour, a short name,
   a motto. Nothing about a student, a member of staff or a mark. That is what
   lets both products serve it before anyone has signed in.
4. **A colour that cannot carry text is refused at entry, with its measured
   ratio — never silently corrected.** See task 3.
5. **The school leads, the product is second, ilumo is third** — but only when
   the school is known. A visitor you cannot place gets the plain ResultPeak
   lockup, because branding a school you cannot name is a guess and a wrong crest
   is worse than none.

## Task 1 — `schools/{id}.slug`

Add an optional `slug: string`.

- Lowercase `[a-z0-9-]`, no leading or trailing hyphen. JDSmartLearn's
  `schoolSlug()` already produces exactly this shape, so existing printed links
  keep resolving.
- **Set once, at school creation.** Never recomputed on rename. A superadmin may
  change it deliberately, and the UI must say that every printed link dies when
  they do.
- **Enforce uniqueness with a `schoolSlugs/{slug}` reservation document** holding
  `{ schoolId }`, written in the same transaction as the school. A
  `where("slug","==",…)` check before the write is a race, and this project
  already has two same-named schools.
- Backfill existing schools with a one-off script that prints each proposed slug
  and requires confirmation. One of these is a live school whose links are
  already in circulation.

Both products serve a school-scoped front door at `/s/{slug}`. JDSmartLearn also
accepts `/s/{schoolId}` — a document id cannot rot — and you should too.

## Task 2 — `schools/{id}.branding`, in this exact shape

**The shape is a contract, not a suggestion.** JDSmartLearn's resolver has a
documented resolution order — its own record first, `schools/{id}.branding`
preferred the moment it exists — and wiring that up is a change to one function.
If the field names differ, that becomes a translation layer instead, and a
translation layer between two products with no shared repo is where drift lives.

```ts
branding: {
  logoUrl:         string   // absolute, served by ResultPeak; see task 4
  logoUpdatedAt:   number   // epoch ms; the ?v= that makes an immutable URL safe
  logoIsIcon:      boolean  // square PNG >= 512px - measured at UPLOAD, see task 5
  shortName:       string   // "Capstone" - fits a 360px header
  colorHex:        string   // "#1B4D3E" uppercase, validated - see task 3
  motto:           string
  updatedAt:       number
  updatedBy:       string
}
```

Every key optional; absent means "not set". Editable by a **school admin for
their own school**, and by a superadmin for any school — never by a tutor.
Enforce it in `firestore.rules` **and** server-side. This field decides what an
unauthenticated visitor sees, so it should not be guarded in only one place.

If you add these to the canonical rules file, note it in
`docs/firestore-rules-to-append.md` in the JDSmartLearn repo too, so both sides
have the same record of what the deployed rules say. The 2026-08-12 incident
recorded in that file happened because a rule was written out by hand in five
places and one of them was weaker.

## Task 3 — The colour gate: copy the file, do not rewrite it

Copy `src/lib/branding/colour.ts` from the JDSmartLearn repo **verbatim**. It is
177 lines, has zero imports, and is not framework-specific — it was written
dependency-free precisely so it could cross to this repo unchanged. Rewriting it
in ResultPeak's idiom produces two contrast tests, and two contrast tests is how
one of them ends up weaker.

What it does: normalise the hex, compute relative luminance, pick **white or ink
whichever reads better**, and refuse the colour outright if neither reaches
4.5:1 — quoting the measured ratio, because a bare "no" leaves an admin guessing
and a darker shade of their own colour usually clears it.

**Three results from JDSmartLearn's CI that will save you an afternoon, because
they are the opposite of what everyone assumes:**

- **A bright school yellow (`#FFD400`) is ACCEPTED**, at 11.93:1 — it carries
  **ink**, not white. So does the ilumo mint, at exactly the 11.21:1 the brand
  spec quotes for `ink on success`.
- **What actually fails is the MIDDLE.** `#808080` at 4.32:1 and `#7D8471` at
  4.40:1 carry neither foreground. These are the colours that look completely
  fine to the eye.
- **Therefore `bestForeground()` is not a lightness threshold**, and must not be
  simplified into one. Luminance is weighted heavily toward green, so a
  mid-yellow and a mid-blue can share a lightness value and want opposite
  foregrounds.

Wire it in at **both** ends, calling the same function: the settings write path,
and CI. JDSmartLearn's `scripts/check-contrast.ts` has a `Per-school colour`
section you can copy alongside it — it asserts the decision rather than a fixed
ratio, so it survives the minimum moving, and it also asserts that the module's
copy of `ink` still matches the palette token.

**Three things the school colour never touches**, and the reasons are already in
`docs/ilumo-brand.md`:

- **The action colour.** Buttons stay indigo. "Only one thing per screen wears
  solid blue" is what tells a user what to do next; per-school, that signal is
  unlearnable for anyone who works at two schools.
- **Status colours.** `warn`, `danger` and `success` do not move. A warning that
  borrowed a brand colour stops reading as a warning — which matters more on a
  results platform than anywhere else in the family.
- **Print.** See task 6.

JDSmartLearn delivers the colour as **three CSS custom properties, server-
rendered**: `--school-bg`, `--school-fg`, `--school-quiet`. No client theme
provider, no per-school stylesheet, no runtime cost. `--school-fg` is computed,
never chosen. `--school-quiet` is a fill and never sits behind text.

## Task 4 — Serving the crest, and the exception it requires

ResultPeak needs somewhere to put the file. **Not Firebase Storage** — that
forces the shared project onto Blaze. Cloudflare R2 is what JDSmartLearn uses;
`src/lib/storage/provider.ts` and `src/lib/storage/r2.ts` are portable, and the
R2 module carries a load-bearing comment about forcing TLS 1.2 that you should
keep if you copy it.

**The serving route must be unauthenticated, and that is a deliberate, bounded
exception.** The screen that needs a crest most is the sign-in screen, where
nobody has a session. Bound it exactly as JDSmartLearn does:

- The URL names a **school**, never a storage key. The key is read server-side
  from that school's own record. An arbitrary key in the path turns the route
  into a read primitive for the whole bucket.
- 404 for a school that is missing, inactive, or has no crest.
- `Content-Type` from a **server-side allowlist**, never from the request and
  never from the stored object's own header.
- `Cache-Control: public, max-age=31536000, immutable`, with `?v={logoUpdatedAt}`
  supplying freshness. A re-upload is a new URL, so there is nothing to
  invalidate.
- **SVG is a document that can carry script.** Serve it with
  `Content-Security-Policy: default-src 'none'; sandbox` and
  `X-Content-Type-Options: nosniff`, or refuse SVG entirely. The admin who
  forwarded their designer's file has not audited it.
- Cap uploads at **150 KB**. This loads before anything a child came for, on a
  throttled 3G link.

Copy `src/lib/branding/crest.ts` for the allowlist, the cap and the PNG header
reader. **Write the exception into ResultPeak's own CLAUDE.md** next to the rule
it bends, as JDSmartLearn did — an undocumented deviation from a "never" is
worse than the deviation.

## Task 5 — Put the school at the top of ResultPeak

- School crest and school name in the header on **every signed-in screen**,
  resolved from the **session's** `schoolId`. **Never from a cookie or a URL
  parameter.** A pre-auth screen may take the school from the URL; a signed-in
  one may not, or a stale value shows a teacher the wrong school's crest above
  their own students' marks. This is the single most important rule in the whole
  task.
- **A monogram fallback, so this works for a school that has uploaded nothing.**
  Copy `src/lib/branding/monogram.ts` — and note the detail that took two
  attempts: it needs **two** word lists. Grammar (`the`, `and`, `of`) may never
  contribute an initial, or "The Cedar School" becomes `TC`. Type words
  (`school`, `academy`, `college`) are initials of **last resort**, which is what
  keeps "Capstone Academy" at `CA` instead of a lonely `C`. One combined list
  gets one of those two cases wrong whichever way you write it.

  Without this, the feature ships broken for every school that has not configured
  a crest — which on day one is all of them.
- `ResultPeak` moves to a small line under the school name, or to the footer.
  `an Ilumotech product` stays in the footer only.
- **If ResultPeak is installable**, serve its web manifest from a route handler
  rather than a static file, and emit the school's `name`, `short_name` and
  `theme_color`. A static manifest means an installed icon says "ResultPeak" —
  the most permanent third-party signal there is, because it sits on the phone
  for years. Use the crest as the icon **only** when `logoIsIcon` is true; that
  flag is measured once at upload, while the bytes are in hand, so no request
  ever has to open the file to answer it. A school that fails that test still
  gets its **name** on the home screen, which is most of the win.

## Task 6 — The report card and anything printed

This is ResultPeak's alone; JDSmartLearn has no printed output and no experience
to lend here.

- A school crest on a report card is a genuine improvement. **Check it on paper,
  in monochrome**, before shipping.
- A colour crest on a monochrome laser printer can be a grey smudge. Never let a
  printed page depend on it, and never let a printed status depend on colour
  alone.
- `logo-mono.svg` exists for the ilumo mark. A school crest has no monochrome
  variant and you cannot make one for them — so the layout has to survive the
  crest being illegible.

## Task 7 — The shared spec

`docs/ilumo-brand.md` is the source of truth for both repositories, and
**section 1 changed on 2026-08-27** from *Endorsed — each product leads with its
own name* to *School-branded, product-endorsed*. Take the amended file from the
JDSmartLearn repo; do not edit your copy independently and do not re-derive the
values. If ResultPeak needs a token the spec lacks, add it to the spec and copy
the file back.

## Definition of done

- [ ] Task 0 answered in writing: one product owns the crest, and the other links
      to it. No second upload form exists.
- [ ] `schools/{id}.slug` exists, is unique by reservation document, is set at
      creation and is never recomputed on rename
- [ ] Existing schools backfilled, with confirmation before each write
- [ ] `schools/{id}.branding` exists **in the shape above**, optional throughout,
      writable only by a school admin for their own school or a superadmin,
      enforced in rules *and* server-side
- [ ] `colour.ts` copied verbatim, called from both the write path and CI; a
      refused colour names its measured ratio and the school keeps indigo
- [ ] The crest route serves only a recorded key, only for an active school, from
      a server-side type allowlist, versioned and immutable; SVG sandboxed or
      refused; the exception written into ResultPeak's CLAUDE.md
- [ ] Every signed-in surface resolves its school from the **session**
- [ ] A school with no branding configured still shows its own name and a monogram
- [ ] The report card checked on paper, in monochrome
- [ ] `docs/ilumo-brand.md` matches the JDSmartLearn copy byte for byte
- [ ] No change to exam behaviour, scoring, or any existing query
- [ ] No new runtime dependency; no Firebase Storage
- [ ] Works at 360px, with a long school name and a short one

## What JDSmartLearn does after this ships

Three changes, all small, all already designed for:

1. `getSchoolBrand()` in `src/lib/branding/school.ts` starts preferring
   `schools/{id}.branding` over `jdSchoolSettings/{id}.branding`, which becomes
   the fallback. The resolution order is already written into that function as a
   comment; **step 2 of it is not implemented yet**, deliberately, because the
   field shape was not settled. One function, no call sites.
2. `/s/{slug}` and `schoolSlug()` resolve against the stored `slug` instead of
   recomputing it from the name, which removes the rename failure.
3. If task 0 lands on ResultPeak owning the crest, JDSmartLearn's upload in
   `/tutor/settings` becomes a link into ResultPeak's settings.

**Tell JDSmartLearn when tasks 1 and 2 land, and say whether `branding` is
populated for any school yet.** The fallback is silent by design, so a field that
exists but is empty everywhere looks exactly like a field that was never shipped
— and that is the state in which somebody wastes an afternoon.
