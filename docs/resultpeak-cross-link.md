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
| `src/app/page.tsx` | "Open ResultPeak" | `/admin` |
| `src/app/(tutor)/tutor/page.tsx` | "Results in ResultPeak" | `/admin/results` |
| `src/app/(student)/student/page.tsx` | "Exams and results" | `/start` |

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
one tap is the wrong trade. Our student link goes to `/start` and the child taps
once more.

If that ever becomes worth fixing, the cheap way is for ResultPeak's `/s/{slug}`
handler to be the only entry point that matters, not for this page to start
reading school documents.
