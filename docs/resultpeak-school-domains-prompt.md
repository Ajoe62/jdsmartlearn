# ResultPeak prompt: school addresses, and who owns branding

Paste the section below into a fresh Claude Code session opened in the
**ResultPeak** repository. That session has none of this context and cannot infer
it.

Two things are in here and they are different in kind:

- **Part A** is confirmation and a short list of requirements about
  `schoolDomains`, which ResultPeak has already built. Mostly "keep doing what
  you are doing, and hold these invariants".
- **Part B was a decision, and it is now settled** (2026-08-29): ResultPeak owns
  the branding record and the crest bytes, and JDSmartLearn's rival editor is
  removed. It is kept here as the reasoning, plus one non-urgent follow-up about
  the installed-icon size.

---

## Part A: `schoolDomains` (already built over there)

```
CONTEXT

JDSmartLearn is the lessons-and-homework product that shares this Firebase
project with ResultPeak. Same projectId, same Auth directory, same Firestore
database. It is a separate repository and a separate Vercel project.

JDSmartLearn has now implemented hostname resolution against schoolDomains. It
reads that collection and never writes it. Its resolver is a direct port of this
repository's src/lib/schoolDomains.js.

WHAT IS ALREADY TRUE, AND MUST STAY TRUE

1. NORMALISATION IS THE SHARED CONTRACT.

   Both repositories normalise a hostname to: lowercase, scheme stripped, path
   stripped, credentials stripped, port stripped, trailing dot stripped, exactly
   one leading "www." stripped, then validated against the DNS label rules.

   The stored document id and the lookup MUST normalise identically. A school
   written as `Portal.School.NG` and looked up as `portal.school.ng` does not
   half-work; it silently disappears, and what the school reports is "the website
   stopped knowing who we are".

   If normaliseHostname() changes here, the same change belongs in
   JDSmartLearn's src/lib/routing/hostname.ts in the same week. Say so out loud
   in the reply if you touch it.

2. REJECT A NON-NORMALISED DOCUMENT ID AT WRITE TIME.

   This is the one concrete gap worth checking. A www.-only check is not enough.
   An id like `Portal.Stbrian.com`, or one carrying a port, or one with a
   trailing dot, would pass a www.-only check and then silently never resolve,
   because the reader normalises and the writer did not.

   The write path must refuse any id where `normaliseHostname(id) !== id`. Not
   normalise-and-accept silently: refuse, and say which form was expected, so the
   admin who typed it learns the rule.

3. RESERVED LABELS ENFORCED AT WRITE, REFUSED AT RESOLUTION.

   Both, not either. RESERVED_HOST_LABELS is enforced here at creation.
   JDSmartLearn refuses to resolve them regardless, so a document written by hand
   in the Firebase console cannot brand one of our own addresses as a school.

   JDSmartLearn additionally refuses a mapping on any PLATFORM host, which is a
   hardening over resolveHostMode() in this repo: over here the write path
   prevents such a document existing, so the ordering is safe; over there it
   might arrive by hand, and the failure would be the whole product wearing one
   tenant's colours. Consider making the same change here for symmetry. It is
   defence in depth, not a bug report.

4. JDSMARTLEARN NEEDS NO WRITE ACCESS AND MUST NOT GAIN ANY.

   It reads by document get through the Admin SDK, so it bypasses rules
   entirely. No rules change is needed for it, and no index: there is one query,
   filtered by schoolId alone with an explicit limit, and picking the primary
   happens in memory precisely so no composite index is required.

   The existing rule is right as it stands:

       match /schoolDomains/{hostname} {
         allow get: if true;
         allow list: if false;
         allow write: if false;
       }

   Keep `list` denied. A listable collection is a public directory of every
   school on the platform.

WHAT JDSMARTLEARN DOES WITH IT

  - Resolves the request hostname server-side, in a root layout helper rather
    than middleware (firebase-admin needs the Node runtime, and middleware runs
    on every asset request, which on the Spark plan is the daily quota).
  - Uses the result to choose which school's crest and colours a SIGNED-OUT page
    wears. Nothing else. schoolId for access comes from the session, always.
  - A resolved hostname beats a stale /s/{slug} school cookie.
  - Uses isPrimary only to PRINT an address on a class sign-in sheet.
  - Never stores the hostname on a record, a session, a token, an audit row or a
    printed card.

A STABLE SLUG IS STILL WANTED, AND IT IS NOT BRANDING

  Both repositories still DERIVE a school's slug from its name at read time
  (schoolSlug() there, partnerLinks.js here). A school correcting a typo in its
  own name therefore breaks every /s/{slug} link it has printed, in both
  directions. This is a real defect and it predates school addresses.

  The fix is a stable, ResultPeak-owned `slug` field on schools/{id} that both
  apps READ and neither derives. It belongs on the school document, not in a
  branding record: /s/:slug is ResultPeak's own route, and putting the slug in a
  branding record would mean ResultPeak reading its own routing key out of a
  display projection.

  JDSmartLearn will read schools/{id}.slug and fall back to its current
  derivation while the field is absent, so this can ship on either side first.
```

---

## Part B: branding ownership. DECIDED 2026-08-29.

**ResultPeak owns the branding record and the crest bytes. JDSmartLearn's editor
and its R2 crest are removed.** What follows is kept as the reasoning; nothing in
it is open any more. The JDSmartLearn side has shipped.

Three reasons, in order of weight:

1. **The offline constraint decided it the opposite way from how it looked.** A
   data URI is not a cross-origin request; it is not a request at all. The bytes
   arrive inside a document this repo already reads, so there is nothing for the
   service worker to allow or deny.
2. **ResultPeak already had it.** Crest, slug and colour predate this repo's
   branding work.
3. **One upload form.** Two editors for one school's crest was the actual defect.

**What JDSmartLearn did:** reads `schoolBranding/{id}` (the projection, not the
source, because it is smaller, it is what ResultPeak's own client reads, and it
carries `logoUpdatedAt`); deleted `jdSchoolSettings.branding`, the R2 crest, the
upload form and its route; kept `/api/schools/{id}/logo`, repointed to decode the
data URI server-side.

**Why that route survived, which is the one thing ResultPeak should know:**
`/api/student/sync` ETags its whole response body. An inline 81 KB base64 crest
would be re-downloaded by every child in a class every time a tutor published a
lesson. Serving it from a versioned same-origin route keeps the payload at **206
to 238 bytes instead of 77.6 to 81.3 KB**, measured across all four schools.

**One open item for ResultPeak, not urgent:** the 240px cap means no crest can be
an installed home-screen icon, which needs 512px square. **Zero schools are
affected today**, so this is not a regression for anyone; it is simply the reason
no school can have its own app icon. The exit condition is a 512px square crest
plus an eligibility flag on the projection.

---

### The reasoning as it stood before the decision

Kept because it records what each side believed, which is the part that explains
how one school ended up with two records in the first place.

At the time, both products stored school branding independently:

| | ResultPeak | JDSmartLearn |
|---|---|---|
| Record | `schools/{id}.branding` | `jdSchoolSettings/{id}.branding` |
| Public projection | `schoolBranding/{id}` | none |
| Crest storage | data URI on the document | Cloudflare R2, key `branding/{schoolId}/crest{ext}` |
| Crest served by | the document itself | `/api/schools/{id}/logo` |
| Editor | ResultPeak admin | `/tutor/settings`, school admin only |
| Field names | `shortName`, `colorHex`, `motto`, `accentHex`, `logoUrl` | `shortName`, `colorHex`, `motto`, `logoKey` |

The text and colour field names match, deliberately. Only the crest differs, and
that difference is the whole question.

### What each side currently believes

ResultPeak's `publicBranding.js` says `schools/{id}.branding` "is the SOURCE OF
TRUTH and stays so: it is the shared record JDSmartLearn's getSchoolBrand()
reads", and describes JDSmartLearn's crest as "a rival crest".

That is not accurate today, and the inaccuracy matters for sequencing:
**`getSchoolBrand()` did not read `schools/{id}.branding` at all** until this
change, and there is still no upload path from ResultPeak into JDSmartLearn's R2
bucket. So neither side is currently reading the other as its source of truth.

### What JDSmartLearn has done in the meantime

Made the read **additive and non-committal**, so nothing is decided by default:

```
1. jdSchoolSettings/{id}.branding   <- this repo's record, per field
2. schools/{id}.branding            <- ResultPeak's record, per field
3. derived                          <- never blank
```

A school configured here is unchanged. A school configured only in ResultPeak now
gets a brand instead of a monogram. Nothing is copied, nothing is written, and
no school's appearance changes without somebody choosing.

It reads `schools/{id}.branding` **directly**, not the `schoolBranding/{id}`
projection: the Admin SDK bypasses rules, `schools/{id}` is already fetched for
the name, so it costs zero extra reads and cannot go stale behind the projection.
The projection is exactly right for ResultPeak's signed-out **client**, which
reads through rules. Two different consumers, two correct answers.

`schoolBranding` and `schoolDomains` are both in JDSmartLearn's
`RESULTPEAK_OWNED` list, so `assertWritable()` refuses a write to either at
runtime, with a test.

### The decision

**Which record wins, and where do the crest bytes live?**

The constraint that rules out the obvious answer: **JDSmartLearn's service worker
refuses every cross-origin request**, and that deny list is not changeable. So a
crest served from ResultPeak's origin, or any third origin, renders online and
breaks offline for every student - on the intermittent-connectivity phones this
product exists for. A **data URI** survives offline; a **cross-origin https URL**
does not.

Three coherent options:

1. **ResultPeak owns branding outright, crest stays a data URI.** JDSmartLearn
   reads `schools/{id}.branding`, retires its own editor and its R2 crest. Works
   offline, because a data URI is self-contained. Costs: the crest rides in every
   sync payload and sits in IndexedDB as base64, on a 3G budget. Needs a size cap
   agreed between the two products.

2. **ResultPeak owns the record, JDSmartLearn keeps serving the bytes.** Requires
   R2 credentials in ResultPeak, or an upload endpoint here. More moving parts,
   but the crest stays a small versioned URL on both sides.

3. **Split by what each side can serve.** ResultPeak owns name, slug and colour;
   JDSmartLearn keeps crest storage and its upload. Two records, divided on a
   defensible line rather than an arbitrary one. This is closest to today, and
   the only one that needs no migration.

**Recommendation: option 1**, unless the base64 payload cost is unacceptable
after measuring - it is the only one with a single editor, and a single editor is
what the "in ONE place" rule was actually protecting.

Whichever is chosen, the loser's editor must be **removed, not left running**. Two
editors on one school's appearance is worse than either choice.

### What must be agreed before anything moves

- Which record wins, per field or wholesale.
- Where the crest bytes live, and the maximum size, given that JDSmartLearn ships
  them to a phone over 3G and stores them in IndexedDB.
- Whether `schools/{id}.branding` gets the `slug` field from Part A. It should
  not: the slug is routing, not branding.
- Who removes their editor, and in which order relative to the read flip.
