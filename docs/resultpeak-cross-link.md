# Cross-links between JDSmartLearn and ResultPeak

Both halves of this are already written. This document exists because the seam
between the two repositories is the thing nobody is watching, and a link that
works today because two environment variables happen to be set is exactly the
kind of arrangement that stops working silently.

## What this is

A school uses both products with one roster and one set of student credentials.
Until now nothing on either screen said the other existed, so a tutor who wanted
to see where their marks ended up had to be told a URL, and a child had to be
told two.

Each product now links to the other. Nothing is shared beyond the URL: no
session, no token, no query parameter carrying identity. A person who follows
the link signs in on the other side with the credentials they already have.

## The contract: one environment variable per side

| Side | Variable | Module |
| ---- | -------- | ------ |
| JDSmartLearn | `NEXT_PUBLIC_RESULTPEAK_URL` | `src/lib/partner-links.ts` |
| ResultPeak | `VITE_JDSMARTLEARN_URL` | `src/lib/partnerLinks.js` |

**An unset variable returns `""` and the caller renders nothing.** Not a
disabled button, not a link to a placeholder, not a link to a default domain.
There is no half-configured state. A dead link on a screen a school is looking
at is worse than an absent one: the absent one is a feature nobody knew to miss,
and the dead one is a product that looks broken.

`NEXT_PUBLIC_` is correct for our side. The value is a public URL that has to
reach the browser and is not a secret in any sense.

## The exception: a school on its own domain

Added 2026-08-31, when ResultPeak began writing two optional origins onto
`schoolBranding/{schoolId}`:

| Field | What it is |
| ----- | ---------- |
| `resultsUrl` | The school's own ResultPeak origin, `https://host`, no path |
| `lessonsUrl` | The school's own JDSmartLearn origin, same shape |

**Absent or `""` is the normal case, not a gap to backfill.** A school without a
domain of its own keeps landing on the shared deployment through the environment
variable, which is what the table above still describes for almost every school.

The precedence is: **the school's own origin, then the variable, then `""`.**
Neither source is ever required. A school with its own domain links correctly on
a deployment where the variable was never set, and a deployment with the variable
set serves every school that has no domain. There is still no half-configured
state, and `""` still means the caller renders nothing.

Three things are worth stating because each is a way this goes wrong quietly.

**On a school's own results domain, the `/s/{slug}` segment is dropped.** The
hostname already identifies the school. Our slug is *derived from the school's
name* (`schoolSlug`), not stored, so sending both is two answers to one question
and a rename makes them disagree — a confident link to the wrong school. A
*path* like `/start/student` is not a slug and is kept on either host: it answers
"which screen", not "which school".

**`resultsUrl` is re-validated on read**, in `getSchoolBrand`, to a bare https
origin with no path, query or credentials — the same reasoning as
`isSafeCrestUrl`. It arrives from another product's document and ends up in an
`href` a child clicks, and a value can predate a rule or be typed into the
Firebase console. A refusal falls back to the shared deployment rather than
throwing: a bad origin must never take a school's results link off every screen
at once.

**`lessonsUrl` is read and deliberately not surfaced.** This repository *is*
lessons. A link from a school's own JDSmartLearn domain to a JDSmartLearn origin
is either a link to the current page or one that moves a signed-in child off
their session's host. It is declared in `PublicBranding` so the field is
documented where it is read, rather than looking like something ResultPeak forgot
to send.

Nothing here changes who writes what: `schoolBranding` is ResultPeak's document
and this repository only ever reads it.

### Both fields were absent everywhere, and the links were wrong because of it

Measured 2026-09-10 against the live project: **`lessonsUrl` and `resultsUrl`
were absent for every school**, including Mt. Cedar British International School
(`dV6zL3AEydAFJc3D3GrO`), whose two addresses are registered, active and marked
primary in `schoolDomains`.

So the precedence fell straight through to the environment variable on both
sides. A member of staff at Mt Cedar signing in at `portal.mtcedar…` and clicking
**Open JDSmartLearn** reached `jdsmartlearn.vercel.app` — the plain product door,
no crest, no colours — and this repository's links back reached the shared
ResultPeak deployment for the same reason.

The table below reads as though the two ResultPeak → JDSmartLearn rows use only
the variable **by design**. They do not; they use the same precedence, and it had
nothing to resolve.

**ResultPeak's projection code was correct and deployed the whole time. It had
simply never run for any existing school**, because it fires on a branding save
and every school predated it. That is the failure worth remembering from this:
correct code that has never executed is indistinguishable, from the school's
side, from code that was never written, and nothing on any screen said which it
was.

Re-measured later the same day, **Mt Cedar is backfilled**:

```
lessonsUrl = "https://learn.mtcedarbritishinternationalsch.com.ng"
resultsUrl = "https://portal.mtcedarbritishinternationalsch.com.ng"
```

and this repository's front door on that host now links to
`https://portal.mtcedar…`, bare, with `/s/{slug}` correctly dropped. The other
three schools still read `null` and correctly so — none has a `schoolDomains`
row, and absent is the documented normal case.

The remaining ask is future-proofing, in
`docs/resultpeak-partner-origin-prompt.md`: make the gap between "registered a
domain" and "projected an origin" visible, so the next school cannot sit in it
unnoticed.

This repository also forwards a signed-out `/s/{slug}` arrival on a platform host
to the school's own address — see `docs/school-addresses.md`. That covers printed
links and bookmarks naming the shared deployment, which no change on ResultPeak's
side can reach.

## Deployment order: independent, in both directions

Each side reads only its own variable and renders only its own link. Neither
reads a field the other writes. Nothing here touches the shared academic record,
`jdSchoolSettings`, `firestore.rules`, or any shape either product owns.

So: ship either side first, ship only one, or roll one back. The other is
unaffected. This is the one cross-repository change so far that carries no
ordering requirement, and it is worth saying explicitly because the previous two
did.

## Where the links are

**JDSmartLearn to ResultPeak** (this repository)

| File | Link | Destination |
| ---- | ---- | ----------- |
| `src/app/page.tsx` (product door) | "Open ResultPeak" | `/admin` |
| `src/app/page.tsx` (school door) | "Results and report cards" | `/s/{slug}`, or the school's own origin bare |
| `src/app/(tutor)/tutor/page.tsx` | "Results in ResultPeak" | `/admin/results` |
| `src/app/(tutor)/tutor/settings/page.tsx` | "Open school profile in ResultPeak" | `/admin` |
| `src/app/(student)/student/page.tsx` | "Take an exam" | `/start` |
| `src/app/(student)/student/page.tsx` | "see your results" | `/start/student?next=results` |

Every one of these resolves against the school's own `resultsUrl` when it has
one, and against `NEXT_PUBLIC_RESULTPEAK_URL` otherwise. The product door is the
one exception: nobody has told it which school this is, so there is no brand to
read and it can only use the variable.

**ResultPeak to JDSmartLearn** (the other repository)

| File | Link | Destination |
| ---- | ---- | ----------- |
| `src/components/PartnerLink.jsx`, in the admin and tutor sidebars | "Open JDSmartLearn" | `/tutor` |
| `src/pages/PortalChooserPage.jsx` | "Open JDSmartLearn" card | `/s/{slug}`, or `/` with no slug |

## Why staff links carry no school, and the student link carries one only once

A tutor or admin signs in on either side with their own Firebase account, and
their custom claims already carry `schoolId`. Putting a school in the path would
be telling the destination something it already knows.

A child is different: they have no account, and the school is what turns a
username like `jss3-04` into a person. Both products serve `/s/{slug}` for
exactly this, and on our side it is a route handler that stores the school on the
device and forwards to sign-in.

**ResultPeak's student card can carry the slug and ours cannot.** ResultPeak's
portal chooser already has the slug in its own URL, so passing it on is free. Our
student dashboard has only `session.schoolId`; `ResultPeakSchool` carries no
`slug`, so producing one would mean a `getSchool()` call. That page is documented
as costing no Firestore reads of its own, and the Spark quota is shared with a
live paying school, so a read on every dashboard load of every student to save
one tap is the wrong trade. Our student links go to `/start` and
`/start/student`, and the child names their school one screen later.

`?next=results` on the second link is a flag, not a destination. ResultPeak
recognises only the literal value `results`; it titles the page "See your
results" and opens the result sheet after sign-in rather than an exam picker.
Nothing in it is a URL, so there is nothing there to redirect to.

If that ever becomes worth fixing, the cheap way is for ResultPeak's `/s/{slug}`
handler to be the only entry point that matters, not for this page to start
reading school documents.
