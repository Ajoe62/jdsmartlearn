# Prompt to run in the ResultPeak repo

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. That session has none of this context and cannot
infer it.

It closes out a live defect at a school that is using both products today: the
"Open JDSmartLearn" button in ResultPeak sends admins, tutors and students to the
shared `jdsmartlearn.vercel.app` deployment instead of to the school's own
lessons address, so they arrive at an unbranded product door.

> **REVISED after review on the ResultPeak side, 2026-09-10.** The first draft of
> this prompt asked for work that was **already live**: the projection (Task 1),
> the re-projection on domain change (Task 2) and the link precedence (Task 4)
> all shipped before it was written. What was actually missing is **the backfill,
> Task 3** — the projection had simply never re-run for a school whose domain was
> registered before it. Tasks 1, 2 and 4 are kept below as the invariants to hold
> while backfilling, not as work to do. **Read Task 3 and Task 5; verify the
> rest.**
>
> Task 5 also changed direction. JDSmartLearn was the side at fault there, it has
> fixed it, and what remains for you is a check rather than a change.

Nothing is needed from JDSmartLearn first. Nothing in `firestore.rules` or
`firestore.indexes.json` changes. The two sides deploy independently, in either
order.

---

## The bug, as the school sees it

Mt. Cedar British International School (`dV6zL3AEydAFJc3D3GrO`) has both
addresses set up and working:

| hostname | product | active | isPrimary |
|---|---|---|---|
| `portal.mtcedarbritishinternationalsch.com.ng` | `resultpeak` | true | true |
| `learn.mtcedarbritishinternationalsch.com.ng` | `jdsmartlearn` | true | true |

A member of staff signs in at `portal.mtcedar…`, sees their own school's crest
and colours, clicks **Open JDSmartLearn** in the sidebar — and lands on
`jdsmartlearn.vercel.app`, which shows the generic product door with no crest,
no school name and no colours. The same happens from the student portal chooser.

The school's own address, `learn.mtcedar…`, is never used, even though it is
registered, active, marked primary, and resolving correctly.

## Why it happens

`src/lib/partnerLinks.js` resolves the JDSmartLearn origin with the documented
precedence — **the school's own origin, then `VITE_JDSMARTLEARN_URL`, then `""`**
— and reads the school's own origin from `schoolBranding/{schoolId}.lessonsUrl`.
That code is correct and already deployed.

**The field was absent anyway**, because the projection that fills it had never
run for this school: its domains were registered before the projection existed,
and nothing had saved its branding since. Measured on 2026-09-10 against the live
project, before the backfill:

```
schoolBranding/dV6zL3AEydAFJc3D3GrO
  displayName   = "Mt. Cedar British"
  logoUrl       = <83030 chars, data:image/png;base64,…>
  logoUpdatedAt = 0
  resultsUrl    = (absent)     <-- and so JDSmartLearn's links back are wrong too
  lessonsUrl    = (absent)     <-- this is the reported bug
```

So the precedence fell straight through to the environment variable, which is the
shared deployment. Correct code plus a never-run backfill produces exactly the
same screen as no code at all.

The address these fields should carry was **already in `schoolDomains`**, written
by this repo, correct, and one query away.

### Re-measured later the same day: Mt Cedar is now backfilled

```
dV6zL3AEydAFJc3D3GrO  "Mt. Cedar British International School"
  lessonsUrl = "https://learn.mtcedarbritishinternationalsch.com.ng"
  resultsUrl = "https://portal.mtcedarbritishinternationalsch.com.ng"
```

Confirmed working from JDSmartLearn's side: its front door on Mt Cedar's host now
links to `https://portal.mtcedarbritishinternationalsch.com.ng`, bare, with the
`/s/{slug}` segment correctly dropped.

**The other three schools still read `null`, and that is correct, not outstanding
work** — none of them has a `schoolDomains` row, so there is no origin to
project. Absent is the normal state for a school without a domain of its own.

That makes Task 3 below **future-proofing rather than an outstanding fix**: the
one school that needed it has it. Read it as "make sure the next school cannot
sit in this state unnoticed", which is the part that recurs.

## The shape of the fix

**Backfill, and hold the invariants that are already in place.** The three tasks
below that describe the projection are there so the backfill can be checked
against them, and so a future change does not quietly undo one. Task 3 is the
only new code.

One thing to keep refusing: **do not add a form field for these two values and
ask admins to type them.** They would be a hand-maintained duplicate of
`schoolDomains`, which is the registry of a school's addresses and already
carries `product`, `active` and `isPrimary`. Two records of one fact drift, and
the drift is silent: the symptom is a school quietly linking to the wrong product
for months.

---

# The work

## Task 1 — ALREADY LIVE. Verify, do not rebuild.
### project `lessonsUrl` and `resultsUrl` from `schoolDomains`

Wherever `schoolBranding/{schoolId}` is written (the public-branding projection,
`api/_lib/branding/publicBranding.js`), set both fields from that school's
`schoolDomains` rows:

- `lessonsUrl` ← the `active`, `isPrimary` row with `product == "jdsmartlearn"`
- `resultsUrl` ← the `active`, `isPrimary` row with `product == "resultpeak"`

Each as a **bare https origin: `https://{hostname}`, no path, no query, no
trailing slash.** Absent or `""` when the school has no such row — that is the
normal case for most schools and must stay a normal case, not an error.

Remember an absent `product` means `resultpeak` (this repo owns the only write
path the collection has ever had, so every row predating the field is one of
yours). JDSmartLearn's port of that rule is in `src/lib/routing/hostname.ts`.

## Task 2 — ALREADY LIVE. Verify, do not rebuild.
### re-project when an address changes, not only when branding does

This is the half that keeps the two from drifting. Registering a domain,
editing one, changing which is primary, or deactivating one must all re-run the
projection for that school. A `lessonsUrl` that is correct on the day it is
written and stale a month later is worse than one that was never set, because
nothing about the screen suggests it is wrong.

## Task 3 — THE ONLY NEW WORK. Backfill, and make the gap visible.

Mt Cedar is **already done** (see the re-measurement above), so this is no longer
about unblocking that school. It is about the next one.

One idempotent script that re-projects every school, dry-run by default. Report
the schools that gained a field, and any school with a `schoolDomains` row but no
branding document, rather than silently skipping it. A school with no domain row
correctly gets `null` and must not be flagged.

The part worth more than the script: **every school in the project predated the
projection, so a projection that only runs on a future save was never going to
reach any of them.** Correct code that has never executed looks exactly like
missing code from the school's side, and nothing on any screen said so. If there
is a cheap way to surface it — a count of schools holding a domain row with no
projected origin, logged or shown in admin — that is the durable half. The
backfill is a one-off; the gap between "registered a domain" and "projected an
origin" is what recurs.

## Task 4 — ALREADY LIVE. Verify, do not rebuild.
### use `lessonsUrl` in the links

- `src/components/PartnerLink.jsx` (admin and tutor sidebars) — "Open JDSmartLearn"
- `src/pages/PortalChooserPage.jsx` — the "Open JDSmartLearn" student card

Both through `src/lib/partnerLinks.js`, keeping the documented precedence: the
school's own origin, then `VITE_JDSMARTLEARN_URL`, then `""` **and render
nothing** — not a disabled button, not a link to a default domain.

Keep the existing `/s/{slug}` rule exactly as it is: **dropped** on a school's own
host, because the hostname already names the school and sending both is two
answers to one question; **kept** on the shared deployment, where it is the only
thing that identifies the school.

## Task 5 — name the school on the STAFF links too

The student card already carries `/s/{slug}`, which is why a child arriving on
the shared deployment gets a branded sign-in and a teacher does not: the staff
links go to `/tutor` carrying no school at all, so JDSmartLearn has nothing to
resolve and renders the plain product door.

JDSmartLearn now accepts `/s/{slug}?next=/tutor` for this. `next` is validated
over there against an exact set of internal paths (`/`, `/tutor`,
`/tutor/sign-in`, `/student`, `/student/sign-in`), so it chooses a screen and
can never carry a destination.

So on the **shared deployment** the staff link should be `/s/{slug}?next=/tutor`
rather than `/tutor`. On a school's **own host** keep it as `/tutor`: the
hostname already identifies the school, and the slug would be the second answer
this rule exists to avoid.

### The slug disagreement — JDSmartLearn's fault, and JDSmartLearn has fixed it

The first draft of this prompt asked you to check that your slug matched a slug
JDSmartLearn derived from the school's name. **That was the wrong way round.**
You store a slug on `schools/{id}.slug` and reserve it in `schoolSlugs/{slug}`;
JDSmartLearn was ignoring both and recomputing one from the name on every read.

Measured 2026-09-10, the two disagreed for **three of the four schools**:

| school | your stored slug | what JDSmartLearn derived |
|---|---|---|
| HIGHER GROUND INTERNATIONAL GROUP OF SCHOOL | `higher-ground` | `higher-ground-international-group-of-school` |
| Mt. Cedar British International School | `mt-cedar` | `mt-cedar-british-international-school` |
| Dlink Academy (ActiveBrains) | *(none stored)* | `dlink-academy-activebrains` |
| CAPSTONE ACADEMY | `capstone-academy` | `capstone-academy` |

So **every `/s/{slug}` link either product printed for Mt Cedar or Higher Ground
landed on JDSmartLearn's school picker, unbranded** — the same screen as the
wrong-host bug, from a completely unrelated cause. The two were being reported
together as one problem.

JDSmartLearn now reads `schools/{id}.slug` and falls back to the derived form
only when it is absent (which is correct for Dlink today). It also still accepts
the old derived form, so class sign-in sheets it printed before this keep working.

**So there is nothing to change here — only to confirm:** keep printing and
linking your own stored slug, and keep `schools/{id}.slug` and
`schoolSlugs/{slug}` in step. If a school is ever allowed to change its slug,
that is worth telling JDSmartLearn about, because both products have paper in
circulation carrying the old one.

---

## Hard constraints

- **`schoolDomains` stays the source of truth for addresses.** `lessonsUrl` and
  `resultsUrl` are a projection of it, never an independent value a human types.
- **`schools/{id}.slug` stays the source of truth for a school's slug**, reserved
  in `schoolSlugs/{slug}`. JDSmartLearn reads it and writes neither.
- **`schoolBranding` keeps exactly one writer.** JDSmartLearn reads this document
  and never writes it, in either direction — a second writer is the thing its
  design rules out.
- **Absent stays a normal state.** A school with no domain of its own must keep
  landing on the shared deployment through the environment variable. There is no
  half-configured state and no value to backfill for those schools.
- Every query filters by `schoolId` and carries an explicit `.limit()`. The
  project moved to Blaze on 2026-09-03, so an unbounded query now bills silently
  instead of failing visibly on a bill shared with a live product.
- Branding carries a crest, a name, a colour and a motto. **It must never carry
  anything about a child or a member of staff** — that is what lets it render
  before anyone has signed in.

## What JDSmartLearn does after this ships

Nothing, and it has already shipped two changes of its own:

- **It reads your stored slug** (`schools/{id}.slug`), instead of deriving one
  from the school name. That is the Task 5 fix above, and it is live.
- **It forwards a signed-out `/s/{slug}` arrival on the shared deployment** to the
  school's own lessons address when `schoolDomains` names one.

It already reads both origin fields, re-validates them on read
(`isSafePartnerOrigin`: a bare https origin, no path, no query, no credentials)
and falls back to the shared deployment rather than throwing, so a malformed
value degrades the link instead of removing it from every screen at once.

The forward covers printed links and bookmarks that name
`jdsmartlearn.vercel.app`, which no change on your side can reach. The two fixes
overlap deliberately and do not conflict — after your backfill runs, most
visitors never reach the shared deployment to be forwarded at all.

## Definition of done

- [ ] A staff member at Mt Cedar clicking "Open JDSmartLearn" lands on
      `learn.mtcedarbritishinternationalsch.com.ng`, with the school's crest,
      name and colours on the sign-in screen
- [ ] A student following the portal chooser card lands there too
- [ ] JDSmartLearn's links back to ResultPeak reach
      `portal.mtcedarbritishinternationalsch.com.ng`, not the shared deployment
- [ ] A school with no domain of its own is unaffected: it still reaches the
      shared deployment through `VITE_JDSMARTLEARN_URL`
- [ ] Registering a new lessons domain updates `lessonsUrl` with no manual step
- [ ] Deactivating a domain clears or moves the field rather than leaving a link
      to an address that no longer answers
- [ ] `lessonsUrl` and `resultsUrl` are bare https origins with no path
- [ ] `/s/mt-cedar` (your stored slug) resolves on JDSmartLearn to Mt Cedar's own
      branded front door — not to a school picker
