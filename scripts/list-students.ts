/**
 * Read-only: list students in a class with their student ID and access code,
 * so you can grab a test student login in one command.
 *
 * Writes NOTHING. Both `students` and `studentAccess` are ResultPeak-owned and
 * only read here. The access code is a LIVE credential - this is a local dev
 * helper for the school's own admin, not something to share.
 *
 *   npx tsx scripts/list-students.ts <schoolId> <classId>
 *
 * classId - a class the tutor teaches (see `npm run list:tutors`).
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
import { RP, QUERY_LIMIT } from "../src/lib/db/collections";

const schoolId = process.argv[2];
const classId = process.argv[3];
if (!schoolId || !classId) {
  console.error("Usage: npx tsx scripts/list-students.ts <schoolId> <classId>");
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
  const adminDb = getFirestore();

  console.log(`\nStudents in class ${classId} (school ${schoolId})`);
  console.log("Access codes are live credentials - keep this output private.\n");

  // Equality-only on two fields: served by single-field indexes (no composite).
  const snap = await adminDb
    .collection(RP.students)
    .where("schoolId", "==", schoolId)
    .where("classId", "==", classId)
    .limit(QUERY_LIMIT)
    .get();

  if (snap.empty) {
    console.log("  No students found for that school + class.");
    console.log("  Check the classId (npm run list:tutors shows the ids a tutor teaches).\n");
    return;
  }

  const students = snap.docs.map((d) => {
    const data = (d.data() ?? {}) as Record<string, unknown>;
    return {
      studentId: d.id,
      name: typeof data.fullName === "string" ? data.fullName : "(no name)",
      admissionNumber:
        typeof data.admissionNumber === "string" ? data.admissionNumber : "",
    };
  });

  // Batch-resolve access codes from studentAccess/{studentId}.
  const refs = students.slice(0, 100).map((s) => adminDb.doc(`${RP.studentAccess}/${s.studentId}`));
  const codeSnaps = await adminDb.getAll(...refs);
  const codes = new Map<string, string>();
  for (const c of codeSnaps) {
    if (c.exists) {
      const code = (c.data() ?? {}).code;
      codes.set(c.id, typeof code === "string" ? code : "(no code field)");
    }
  }

  for (const s of students) {
    const code = codes.get(s.studentId) ?? "(no studentAccess doc)";
    const adm = s.admissionNumber ? `  [${s.admissionNumber}]` : "";
    console.log(`- ${s.name}${adm}`);
    console.log(`    student ID:  ${s.studentId}`);
    console.log(`    access code: ${code}`);
  }

  const withCode = students.filter(
    (s) => codes.has(s.studentId) && !codes.get(s.studentId)!.startsWith("(")
  );
  console.log(`\n${students.length} student(s), ${withCode.length} with a usable access code.`);
  if (withCode.length) {
    const s = withCode[0];
    console.log(`Test login -> student ID: ${s.studentId}   code: ${codes.get(s.studentId)}`);
  } else {
    console.log("No usable access codes found - generate them in ResultPeak first.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
