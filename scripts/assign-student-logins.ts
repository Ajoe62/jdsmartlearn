/**
 * Give students memorable sign-in usernames (`jss3-04`) instead of a
 * 20-character document id.
 *
 * Writes ONLY to `studentLogins`, which JDSmartLearn owns. `students` and
 * `studentAccess` are ResultPeak-owned and are read here and never touched.
 *
 * Dry run by default - nothing is written until you pass --write.
 *
 *   npx tsx scripts/assign-student-logins.ts <schoolId> [classId] [--write]
 *
 * classId - omit to do every class in the school (see `npm run list:tutors`).
 */
import process from "node:process";

try {
  process.loadEnvFile(".env.local");
} catch {
  console.error(
    "Could not load .env.local. Run this from the project root (c:\\Users\\DELL\\jdsmartlearn)."
  );
  process.exit(1);
}

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { JD, RP, QUERY_LIMIT } from "../src/lib/db/collections";
import { classSlug, loginDocId, usernameFor } from "../src/lib/db/usernames";

const args = process.argv.slice(2).filter((a) => a !== "--write");
// npm swallows --write into its own config, so honour both forms.
const write = process.argv.includes("--write") || process.env.npm_config_write === "true";
const schoolId = args[0];
const onlyClassId = args[1];

if (!schoolId) {
  console.error(
    "Usage: npx tsx scripts/assign-student-logins.ts <schoolId> [classId] [--write]"
  );
  process.exit(1);
}

async function main() {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!privateKey || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PROJECT_ID) {
    console.error("Missing Firebase Admin credentials in .env.local.");
    process.exit(1);
  }
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  }
  const db = getFirestore();

  const classSnap = await db
    .collection(RP.classes)
    .where("schoolId", "==", schoolId)
    .limit(QUERY_LIMIT)
    .get();

  const classes = classSnap.docs
    .map((d) => ({ id: d.id, ...(d.data() as { name: string; isActive?: boolean }) }))
    .filter((c) => c.isActive !== false)
    .filter((c) => !onlyClassId || c.id === onlyClassId)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!classes.length) {
    console.log("No matching classes. Check the schoolId and classId.");
    return;
  }

  console.log(`\n${write ? "ASSIGNING" : "DRY RUN"} - school ${schoolId}\n`);

  let created = 0;
  let skipped = 0;

  for (const cls of classes) {
    const students = (
      await db
        .collection(RP.students)
        .where("schoolId", "==", schoolId)
        .where("classId", "==", cls.id)
        .limit(QUERY_LIMIT)
        .get()
    ).docs
      .map((d) => ({ id: d.id, ...(d.data() as { fullName?: string; isActive?: boolean }) }))
      .filter((s) => s.isActive !== false)
      .sort((a, b) => (a.fullName ?? "").localeCompare(b.fullName ?? ""));

    console.log(`${cls.name}  (${students.length} active)`);

    if (!students.length) {
      console.log("  no students\n");
      continue;
    }

    // A username without an access code is a dead end. This also skips the
    // duplicate roster-only records that exist in ResultPeak.
    const accessSnaps = await db.getAll(
      ...students.slice(0, QUERY_LIMIT).map((s) => db.doc(`${RP.studentAccess}/${s.id}`))
    );
    const withCode = new Set(accessSnaps.filter((s) => s.exists).map((s) => s.id));

    // Which of them already have a username.
    const existing = new Map<string, string>();
    const ids = students.map((s) => s.id);
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const snap = await db
        .collection(JD.studentLogins)
        .where("schoolId", "==", schoolId)
        .where("studentId", "in", chunk)
        .limit(30)
        .get();
      for (const d of snap.docs) {
        const login = d.data() as { studentId: string; username: string };
        existing.set(login.studentId, login.username);
      }
    }

    const prefix = classSlug(cls.name);
    const taken = new Set(existing.values());
    let next = 1;

    for (const s of students) {
      const name = s.fullName ?? "(no name)";

      if (existing.has(s.id)) {
        console.log(`  ${existing.get(s.id)!.padEnd(12)} ${name}  (already had one)`);
        skipped++;
        continue;
      }
      if (!withCode.has(s.id)) {
        console.log(`  ${"-".padEnd(12)} ${name}  (no access code - issue one in ResultPeak)`);
        skipped++;
        continue;
      }

      // Walk forward until a number sticks. create() fails if another run (or
      // the teacher's button) claimed it first, so the loop retries rather than
      // overwriting someone else's username.
      let username: string | null = null;
      while (!username && next <= QUERY_LIMIT * 2) {
        const candidate = usernameFor(prefix, next);
        next++;
        if (taken.has(candidate)) continue;

        if (write) {
          try {
            await db.doc(`${JD.studentLogins}/${loginDocId(schoolId, candidate)}`).create({
              schoolId,
              studentId: s.id,
              username: candidate,
              createdAt: Date.now(),
            });
          } catch {
            continue; // Claimed since we read. Next number.
          }
        }
        username = candidate;
      }

      if (!username) {
        console.log(`  ${"-".padEnd(12)} ${name}  (no free username for ${prefix})`);
        skipped++;
        continue;
      }

      existing.set(s.id, username);
      taken.add(username);
      console.log(`  ${username.padEnd(12)} ${name}`);
      created++;
    }

    console.log("");
  }

  console.log(
    `${created} username(s) ${write ? "created" : "would be created"}, ${skipped} skipped.`
  );
  if (!write) console.log("Re-run with --write to save them.\n");
  else console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
