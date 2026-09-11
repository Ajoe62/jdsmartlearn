# Architecture notes

## Shared Firebase project

JDSmartLearn is a **second web app registered inside ResultPeak's Firebase
project**. Same `projectId`, same Auth directory, same Firestore database.
"Reading ResultPeak data" is therefore just a Firestore query - there is no
API, sync job, or webhook between the products.

Separate: repos, deployments, domains, UI.
Shared: Auth users, database, rules, indexes, and **quota**.

## Why Cloudflare R2 and not Firebase Storage

Originals go to Cloudflare R2 (free tier, zero egress) via
`src/lib/storage/provider.ts`, and are only ever served through authenticated
routes - never a public bucket URL. Firebase Storage stays forbidden even though
the project is on Blaze now; CLAUDE.md gives the reasons that outlived the
billing argument.

The extracted text is stored alongside the file, not instead of it, and remains
the student-facing default: it is a fraction of the bytes on a 3G link, and it is
what the offline store holds. If R2 credentials are absent, uploads degrade to
text-only and the product still works.

Firestore documents cap at 1 MB, which the text comfortably fits - a lesson is
typically 5-50 KB.

## How files move

A Vercel function refuses any request or response body over **4.5 MB**. Until
2026-09-11 every file went through one, so every lesson, scheme of work or photo
above that size failed with a platform error nobody could read. Now bytes never
pass through a function above 4 MB.

**Upload** - one flow for lessons, schemes of work, assignment question sheets
and student attachments:

1. The browser asks `POST /api/uploads` (`action: "start"`) for an address. The
   route checks the session, the purpose (tutors upload originals, students
   attach work), the type, and the size cap - 100 MB for a tutor, 20 MB per
   student file. It returns a staging key
   `uploads/{schoolId}/{t-uid | s-studentId}/{token}{ext}` and either one
   presigned PUT (up to 8 MB) or a multipart upload in 8 MB parts.
2. The browser PUTs straight to R2 (`src/lib/upload-client.ts`), retrying a part
   on a dropped connection, with a real progress bar.
3. The browser calls the ordinary create or attach route with the staging key.
   That route runs its own school, class and subject checks, THEN
   `claimUpload()` (`src/lib/storage/uploads.ts`): the key must be this user's,
   the real size is read from R2, and the object is copied server-side to its
   permanent key (`src/lib/storage/keys.ts`) with a MIME type from our allowlist.
4. Uploads nobody claims are deleted by the bucket's lifecycle rule after a day.

**Download** - every file route authorizes first, then `serveStoredFile()`
(`src/lib/storage/serve.ts`) streams files up to 4 MB as before, and answers
larger ones with a 302 to a presigned GET that names one object and expires in
ten minutes.

**Text** is read best effort from PDF, Word (.doc and .docx) and .txt, up to
25 MB. A file with no readable text is still a lesson or a scheme: students open
the original, and a lesson's study guide waits until the tutor adds the text.

The bucket needs a CORS rule and a lifecycle rule for any of this to work - see
[r2-bucket-setup.md](r2-bucket-setup.md).

## Why no Cloud Functions

The project is on the Spark plan and Functions require Blaze. All server logic
runs in Next.js route handlers with the Admin SDK, deployed on Vercel. This
also keeps the AI key server-side and matches the runtime planned for
ResultPeak's server-graded results cutover.

## Function timeout risk

Generation can take 20-40s on a long lesson. `maxDuration` is set to 60 on the
generate route. **Verify your host's actual limit before the pilot.** If it is
lower, switch to the async pattern: the route sets `status: "generating"`,
returns immediately, and the UI polls the lesson document.

## Class level

`topics.level` drives the AI reading band, which is the difference between a
usable Primary 3 summary and an unusable one. If ResultPeak's `classes`
records lack an explicit level field, add it **in ResultPeak**, not here -
that collection has a single owner.

## Quota discipline (shared Spark plan)

A runaway query here can exhaust the daily read quota and break a paying
school's exam day. Every query filters by `schoolId` and has a `.limit()`.
No `onSnapshot` listeners. Cache published lesson content. Do not deploy
during a school's exam window.
