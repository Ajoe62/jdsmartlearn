# School addresses

How a school gets its own web address, what that changes, and the much longer
list of what it deliberately does not change.

---

## The one rule

**A hostname is a routing hint. It is never a security boundary.**

Anybody can point a DNS record at this deployment. It costs them nothing, needs
no permission from us, and cannot be prevented. So resolving a hostname grants
nothing: it chooses which school's crest and colours a **signed-out** page wears,
and that is the whole of it.

- A student session is still a signed cookie verified server-side.
- A tutor session still carries Firebase custom claims.
- `schoolId` **for access purposes** comes from the session, on every request.

A stranger who points their own domain at this app gets a sign-in screen wearing
somebody's colours and not one row of data. Those colours were already public:
they render on `/s/{slug}` today, to anyone, signed out.

The corollary, and the rule most likely to be broken by accident: **the hostname
is never stored.** Not on a record, not on a session, not in a token, not on an
audit row, not on a printed sign-in card. It is resolved per request and
discarded. That is precisely what makes the upgrade below free.

---

## The three tiers

| Tier | Address | What it costs the school |
|---|---|---|
| 1 | `/s/{slug}` on the shared domain | Nothing. Works today, keeps working. |
| 2 | `{school}.{zone}` | One Firestore document. No DNS work: one wildcard record covers every school. |
| 3 | `portal.theirdomain.com` | One more Firestore document, and one CNAME by their web person. |

**All three resolve at once and indefinitely.** Adding a purchased domain does
not retire the free subdomain. Bookmarks, printed login sheets and a manifest
installed on a parent's phone all keep working, and nothing has to be reissued.
Exactly one document per school carries `isPrimary`, and its only job is to be
the address the app **prints** when it has to write one down.

Moving from tier 2 to tier 3 is one document and one DNS record. Nothing is
rebuilt, and no address stops working.

### The slug is ResultPeak's, and this repo reads it

`/s/{slug}` only works if both products mean the same string by `{slug}`. They
did not. ResultPeak stores a slug on `schools/{id}.slug` and reserves it in
`schoolSlugs/{slug}`; this repo ignored both and recomputed one from the school's
name on every read. Measured 2026-09-10, they disagreed for **three of the four
schools in the project**:

| school | stored (ResultPeak) | derived (here, before the fix) |
|---|---|---|
| HIGHER GROUND INTERNATIONAL GROUP OF SCHOOL | `higher-ground` | `higher-ground-international-group-of-school` |
| Mt. Cedar British International School | `mt-cedar` | `mt-cedar-british-international-school` |
| Dlink Academy (ActiveBrains) | *(none)* | `dlink-academy-activebrains` |
| CAPSTONE ACADEMY | `capstone-academy` | `capstone-academy` |

So every `/s/{slug}` link ResultPeak printed for two of these schools landed on
this side's school picker — unbranded, no error anywhere, because an unknown slug
is *designed* to fall through to the picker. **It is the same symptom as a link
pointing at the shared deployment, from a completely unrelated cause**, which is
why the two were reported together as one problem.

`canonicalSchoolSlug()` in `src/lib/db/resultpeak.ts` is now the only answer:
ResultPeak's stored slug, falling back to the name-derived form only when it is
absent — which is correct for Dlink today, and is a real state rather than a gap.
It is read in both places that need it: `getSchoolDirectory()`, which resolves an
inbound `/s/{slug}`, and `getSchoolBrand()`, whose `slug` is what
`printableSchoolAddress()` puts on **paper**.

The name-derived form still *resolves* (`SchoolListing.legacySlug`), and is never
printed. This repo put it on class sign-in sheets before the stored slug was read
here, and paper does not get recalled. It is matched second, so a stored slug
always wins, and through the same "exactly one match" guard — an alias must never
make two schools answer to one link.

### A school that has an address is sent to it

`/s/{slug}` on a **platform host**, for a visitor with **no session**, forwards
to `https://{primaryAddress}/s/{slug}` when the school has a lessons address of
its own. The destination then resolves the school from its own hostname — which
beats the cookie — pins the device and brands every screen.

This exists because a school's real address can be registered and working while
something still points a person at the shared deployment. That happened, and it
was not rare: ResultPeak's "Open JDSmartLearn" links read
`schoolBranding.lessonsUrl`, which is **absent for every school in the project**,
so every one of them fell through to `VITE_JDSMARTLEARN_URL`. The fix over there
is `docs/resultpeak-partner-origin-prompt.md`; this is the half that does not
wait for it, and the only half that can recover a printed link or a bookmark
naming `jdsmartlearn.vercel.app`.

Three guards, in `src/app/s/[slug]/route.ts`:

- **Never a signed-in visitor.** Cookies are host-scoped, so a cross-origin hop
  drops their session. Cookie presence is enough and is deliberately not
  verified — this decides whether to be helpful, not whether to grant anything.
- **Never off a school's own host**, so the destination cannot forward again and
  there is no loop.
- **Never a destination from the request.** The host comes from `schoolDomains`;
  `?next=` only picks a path, from an exact-match set.

A school with no lessons address gets `""` from `primaryAddress()` and the
unchanged behaviour, which is most schools and is not a gap.

`?next=` is what lets a **staff** link name a school. ResultPeak's student card
already carries `/s/{slug}`; its staff links go to `/tutor` with no school, which
is why a child got a branded sign-in on the shared deployment and a teacher did
not.

---

## A school needs TWO hostnames, one per app

ResultPeak and JDSmartLearn are **separate Vercel projects**. A hostname resolves
to one project. There is no arrangement in which both apps answer on one
hostname without a proxy in front of them, and we are not building one: a proxy
is a new always-on component in front of a paying school's live exams, and the
thing it would buy is a shorter address.

So a school gets two, and they should be named so a parent can tell them apart:

```
results.capstone.edu.ng    ->  ResultPeak   (exams, report cards)
learn.capstone.edu.ng      ->  JDSmartLearn (lessons, homework)
```

On the free zones, likewise, one label per app under each product's own zone.
Each repo has its own `SCHOOL_DOMAIN_ZONE` and its own `PLATFORM_HOSTS`, and
neither knows the other's.

The two apps still link to each other: `NEXT_PUBLIC_RESULTPEAK_URL` here, and
`VITE_JDSMARTLEARN_URL` there.

### Which app an address is for: `product`

`schoolDomains/{hostname}` carries `product`, valued `resultpeak` or
`jdsmartlearn`. **An absent value means `resultpeak`**, because ResultPeak owns
the only write path this collection has ever had, so every row predating the
field is one of its own. Nothing needed backfilling on either side.

It exists because both apps read one collection and each has to print ONE
address. Before it, a school holding both addresses had a single `isPrimary`
flag between them, and the alphabetical tie-break handed both apps whichever
sorted first. What that produced was a tutor's lessons sign-in card naming the
exam portal, and a class login sheet telling a child to sit an exam at
`learn.theirschool.ng`.

So `isPrimary` is now scoped per product: both of a school's addresses carry it
at once, for different things. `primaryAddress()` and `printableSchoolAddress()`
filter to `THIS_PRODUCT`, always.

**Resolution ignores the field entirely** (`lookupSchoolDomain`), and that is a
decision rather than an omission. DNS already chose which app answers a
hostname: a request only reaches this deployment because a record points here. A
row labelled for the other product is a mislabelled row, and refusing to resolve
it would show the not-set-up page to a school whose address works perfectly, for
a field no visitor can see. **Do not add that filter.**

The write path is ResultPeak's, as ever. A school's lessons address is
registered over there, with `"product":"jdsmartlearn"`, and skipping that is the
mistake to expect: it leaves this app showing the not-set-up page on an address
whose DNS is correct.

---

## How resolution works in this repo

### Where it happens

In a **server helper called from the root layout**, not in middleware
(`src/lib/routing/request-school.ts`). Three reasons, all binding:

1. The lookup needs the Admin SDK, and `firebase-admin` needs the Node runtime.
   Next middleware is Edge by default and Node middleware is still experimental
   in Next 15.
2. Middleware runs on **every** request, including every static asset and
   prefetch. A Firestore read there, on a Spark plan shared with a live school's
   exam day, is the daily quota.
3. `unstable_cache` and React `cache()` both work here and neither works in
   middleware, so the caching that makes point 2 true is only available on this
   side.

The cost is that a Server Component cannot **set** a cookie, so a stale school
cookie is not physically rewritten during a plain page render. That costs
nothing, because nothing reads the cookie directly: every caller goes through
`brandingSchoolId()`, where the hostname wins before the cookie is read. The
cookie is reconciled in `/api/student/session/refresh`, a route handler that
`boot()` already calls on every app open and every reconnect.

### Normalisation

**Lowercase, strip the port, strip the trailing dot, strip exactly one leading
`www.`.** Plus: a pasted scheme, path or credentials are tolerated and removed,
and anything that is not a plausible hostname resolves to `""`.

`www.` is stripped deliberately. `www` is a reserved label and can never be a
school's own name; a school pointing both `portal.x.com` and `www.portal.x.com`
at us means one address, not two; and two documents for one address is how one
of them goes stale. Stripping is the **generous** direction, which is safe
precisely because a hostname grants nothing - the worst case of resolving
generously is a school seeing its own page, while not stripping strands a
visitor who typed `www.`.

**The stored document id and the lookup must normalise identically.** A school
written as `Portal.School.NG` and looked up as `portal.school.ng` does not
half-work; it silently disappears, and what the school reports is "the website
stopped knowing who we are". `src/lib/routing/hostname.ts` is a **port** of
ResultPeak's `src/lib/schoolDomains.js`, which owns the write path. An edit to
one belongs in the other in the same change.

### Order

1. `schoolDomains/{hostname}` lookup
2. the existing school cookie from `/s/{slug}`
3. the not-set-up page

A **platform host is never looked up at all**: `localhost`, `127.0.0.1`,
`*.vercel.app`, `*.local`, `*.test`, the configured `PLATFORM_HOSTS` and the zone
apex. They fall straight through to cookie-or-slug behaviour, which is exactly
what this app did before school addresses existed. That is both the correct
behaviour and the quota guard.

### The cookie collision

**A resolved hostname beats a conflicting school cookie. Always.**

`/s/{slug}` remembers a school on a device for a **year**. Without this rule a
phone that once opened school B's link would carry B's identity onto school A's
own address forever. The visitor typed the address; the cookie is a year-old
side effect they have forgotten about.

Neither input is trusted for anything but decoration - the cookie is
attacker-supplied (any visitor can set it by opening `/s/anything`) and so is the
hostname. Which is why this only ever runs for someone with **no session**. A
signed-in surface takes `schoolId` from the session, so a teacher signed in at
one school sees their own school's crest above their own class's data whatever
address they typed.

An **unmapped** hostname returns null rather than falling through to the cookie.
An address nobody has set up is not an invitation to guess.

### Reserved labels

`www`, `api`, `admin`, `app`, `mail` and a long list besides
(`RESERVED_HOST_LABELS`). Enforcement belongs at ResultPeak's write path, because
ResultPeak creates these documents. This repo refuses to resolve them anyway:
**both, not either.** A document written by hand in the Firebase console, or by a
build that predates its own check, still must not brand one of our addresses as a
school.

Scoped to our zone, deliberately. `admin.someschool.com` is the school's own
business and none of ours; `admin.{zone}` is an address we need.

This repo also refuses a mapping on any **platform host**, which is a deliberate
hardening over the ResultPeak original. Over there the write path prevents such a
document existing; here it might arrive by hand, and the failure would be the
whole product wearing one tenant's colours.

**A subdomain label is never parsed into an identity.** `capstone.{zone}`
resolves because a document says so, never because the label reads like a school.
Deriving a `schoolId` or a slug from a label is what would make DNS an
authorization surface.

### The not-set-up page

An unmapped hostname gets a plain page that **names no school and lists no
tenants**. Not "did you mean Capstone Academy?", which would turn it into a
public directory of every school on the platform, enumerable by anyone with a
domain and five minutes. It also does not distinguish unknown from misspelled
from retired: those are different facts about a real school, and telling them
apart out loud is the same leak in a smaller font.

It is applied at the root layout, so it covers every page. It is deliberately
**not** applied to `/api` route handlers: those authorize from the session every
time, so refusing them would protect nothing while breaking a deployment whose
operator has not finished configuring `PLATFORM_HOSTS`.

---

## Branding, and what the address does not buy

**Branding is keyed by `schoolId`, never by hostname.** A school still on
`/s/{slug}` gets the same crest, the same colours and the same page title as a
school on a domain it paid for. The address tier buys a nicer thing to write on a
letter; it buys nothing about how the product looks, or "upgrade for your own
colours" becomes the shape of the product and the school that cannot afford a
domain is visibly a lesser tenant to its own parents.

Enforced structurally: `getSchoolBrand(schoolId)` takes one argument, and nothing
in `src/lib/branding/school.ts` reads a header, a request or a hostname. There is
a test asserting exactly that.

### Offline

The student device already mirrors branding onto its meta row through the
existing sync (`OfflineBrand`), so a cached lesson paints in the school's colours
with no network. There is **no new sync mechanism** and no branding endpoint,
because a branding endpoint would be polled and polling is forbidden.

The crest is the one part that can fail:

- **`/api/schools/{id}/logo`** is same-origin and already on the service worker's
  allowlist, so it survives offline. The deny list was **not** changed for any of
  this. The route now decodes ResultPeak's data URI server-side and serves plain
  image bytes, so a data URI never reaches a device at all.
- That indirection is also what keeps the sync payload small. ResultPeak's crest
  is 77 to 81 KB of base64, and `/api/student/sync` ETags its **whole** body, so
  an inline crest would cost every child in a class a fresh 81 KB every time a
  tutor published a lesson. Measured: **206 to 238 bytes shipped, against 77.6 to
  81.3 KB inline.** The URL is versioned by `logoUpdatedAt`, which moves only
  when the crest bytes move, so a motto edit rewrites nothing.
- **A cross-origin `https` crest** cannot survive: the service worker refuses
  every cross-origin request as its second check. It is never proxied and never
  saved, so it degrades to the monogram.

What a child sees in that case is the school's monogram reversed out of the
school's colour - the school's name in text, never a broken image. `SchoolMark`
renders the monogram always and layers the crest on top, so a crest that fails to
load degrades to text with no JavaScript at all.

Cached branding lives and dies with the rest of the store: the 7-day
`STUDENT_OFFLINE_GRACE_DAYS` window, the revocation wipe on reconnect, and the
owner check at boot.

### One school's content per device

Signing in as a different student already wipes the store. A device **changing
school** now wipes it too (`ownerVerdict`, `src/lib/offline/owner.ts`): a phone
carried to another school's address must not still be holding the first school's
lessons, and the student check does not catch it, because a device is only
re-owned when somebody signs in.

Both identities come from the **session**, never the hostname. Letting a hostname
trigger a wipe would hand any stranger with a DNS record the power to erase a
child's saved lessons by being visited once.

A store written before this field existed is **backfilled, not wiped**: its
absence means "older store", not "school changed", and wiping on deploy would
cost every child their saved lessons for nothing.

---

## Printed sign-in sheets

The tutor sign-in sheet carries the school's crest, the school's name and the
school's **primary** address. For most parents that piece of paper is the first
time this product exists at all, and it should read as something their school
issued.

What is printed is the address the school **nominated** (`isPrimary`), never the
hostname the page was served on. A sheet printed on the free subdomain must not
bake that subdomain in, or every sheet has to be reprinted the day the school
buys a domain. With no primary address it falls back to the platform host plus
`/s/{slug}`, which is what sheets said before this feature existed.

The sheet stays tutor-only and network-only. It renders live access codes, so it
must never be added to the service worker allowlist.

---

## Ownership

**`schoolDomains` is ResultPeak's.** This repo reads it by document get through
the Admin SDK and never writes it, `product` included: the field is read and
filtered on here, and only ever set over there. `assertWritable()` refuses at runtime, with a
test. No rules change and no index is needed on this side.

`schoolBranding` is **also ResultPeak's**, and since 2026-08-29 so is branding
outright. It is a derived projection of `schools/{id}.branding` with exactly one
writer over there. This repo reads the projection and writes neither.

The two-records-two-editors problem is gone: this repo's `jdSchoolSettings`
branding record, its R2 crest and its `/tutor/settings` upload form were
**deleted, not deprecated**. Crest, colour, short name and motto are edited once,
in ResultPeak's school profile. Nothing was lost, because no school had ever used
the editor here.

A **missing projection means the school was purged**, not that it is waiting to
be backfilled: ResultPeak deletes it as a stage of its purge cascade. Render the
product lockup, never a stale crest.

Changes to either collection go to the ResultPeak repository. Rules for them
belong in ResultPeak's canonical `firestore.rules`, never deployed from here.
