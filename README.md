# JDSmartLearn

Upload a lesson. Get a student summary and practice questions back in minutes.

An LMS for Nigerian primary and secondary schools, sharing a Firebase project
with **ResultPeak**. Read `CLAUDE.md` before writing any code - it contains the
hard constraints, not preferences.

## The one loop this MVP proves

Teacher uploads a lesson -> AI generates a summary, practice questions, and a
marking guide -> teacher reviews and edits -> publishes -> students read it.

Anything that does not make that loop faster or more reliable is out of scope.

## Setup

```bash
npm install
cp .env.example .env.local     # fill in - see below
npm run dev
```

### Firebase (same project as ResultPeak)

1. Firebase console -> Project settings -> Your apps -> **Add app (Web)**,
   named "JDSmartLearn". **Do not create a new project.**
2. Copy the config into the `NEXT_PUBLIC_FIREBASE_*` vars. `projectId` will
   match ResultPeak's - that is correct.
3. Authentication -> Settings -> Authorized domains: add your dev and Vercel
   domains, or tutor sign-in will fail.
4. Project settings -> Service accounts -> generate a key. Put the values in
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
   **Never commit this file.**

### Gemini

Get a free API key from Google AI Studio, set `GEMINI_API_KEY`.

### Student session secret

```bash
openssl rand -base64 32   # -> STUDENT_SESSION_SECRET
```

### Seed topics

```bash
npx tsx scripts/seed-topics.ts <schoolId>
```

## Structure

```
src/lib/firebase/    Admin SDK (server) and client auth
src/lib/auth/        tutor sessions (Firebase Auth) + student sessions (ID + code)
src/lib/ai/          provider abstraction, Gemini adapter, prompt bands, Zod schema
src/lib/db/          collection ownership, ResultPeak read-only accessors, lessons
src/lib/extract/     in-memory PDF/DOCX text extraction
src/app/api/         route handlers - all server logic lives here
seed/topics/         human-authored curriculum, never AI-generated
docs/                architecture notes + rules to append in the ResultPeak repo
```

## Rules you cannot break

- **Never write to a ResultPeak-owned collection.** `assertWritable()` guards this.
- **Never deploy Firestore rules from this repo.** See `docs/firestore-rules-to-append.md`.
- **Never send personal data to the AI provider.** Lesson text, subject, topic, level only.
- **Never return marking guide content to a student.** Build the student copy with
  `toStudentPayload()` — it names its fields so a guide cannot be spread in.
- **Never use Firebase Storage.** Originals go to Cloudflare R2 through
  `src/lib/storage/provider.ts`, served only via the authenticated file route.
- **Never let a marking guide reach a student's device.** The offline store and the
  service worker deny-list both depend on this. See `docs/OFFLINE-FIRST.md`.

## Build order

1. Tutor sign-in -> dashboard reading `assignedClasses` from ResultPeak
2. Lesson upload + text extraction
3. Generation + mandatory review/edit screen + publish
4. Student portal via student ID + access code
5. Pilot with the school, scoring primary and secondary output separately
