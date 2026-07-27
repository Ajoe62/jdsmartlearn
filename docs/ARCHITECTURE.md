# Architecture notes

## Shared Firebase project

JDSmartLearn is a **second web app registered inside ResultPeak's Firebase
project**. Same `projectId`, same Auth directory, same Firestore database.
"Reading ResultPeak data" is therefore just a Firestore query - there is no
API, sync job, or webhook between the products.

Separate: repos, deployments, domains, UI.
Shared: Auth users, database, rules, indexes, and **quota**.

## Why Cloudflare R2 and not Firebase Storage

Firebase Storage generally requires the Blaze plan, and this project shares its
Firebase project with a live paying school - moving that project to Blaze is not
ours to do. Originals therefore go to Cloudflare R2 (free tier, zero egress) via
`src/lib/storage/provider.ts`, and are served only through the authenticated
`/api/lessons/[id]/file` route. Never a public bucket URL.

The extracted text is stored alongside the file, not instead of it, and remains
the student-facing default: it is a fraction of the bytes on a 3G link, and it is
what the offline store holds. If R2 credentials are absent, uploads degrade to
text-only and the product still works.

Firestore documents cap at 1 MB, which the text comfortably fits - a lesson is
typically 5-50 KB.

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
