/**
 * Read-only diagnostic: why does a tutor see "No classes are assigned to you yet"?
 *
 * Writes NOTHING. It only reads, to pin down which of these is true:
 *   1. the Auth user / custom claims are wrong (schoolId mismatch, inactive),
 *   2. the ResultPeak tutor profile is missing or has no assignedClasses,
 *   3. assignedClasses holds ids that don't resolve in the `classes` collection.
 *
 *   npx tsx scripts/diagnose-tutor.ts <schoolId> <tutorUid>
 *
 * schoolId  - the school the tutor belongs to (their schoolId custom claim)
 * tutorUid  - the Firebase Auth UID (Console > Authentication > Users)
 */
import process from "node:process";

// Load creds before touching firebase-admin. We init the Admin SDK directly
// (below) rather than importing src/lib/firebase/admin, which pulls in Next's
// "server-only" guard - that module only resolves inside the Next bundler, not
// under tsx/node.
try {
  process.loadEnvFile(".env.local");
} catch {
  console.error(
    "Could not load .env.local. Run this from the project root (c:\\Users\\DELL\\jdsmartlearn)."
  );
  process.exit(1);
}

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { RP } from "../src/lib/db/collections";

const schoolId = process.argv[2];
const tutorUid = process.argv[3];
if (!schoolId || !tutorUid) {
  console.error("Usage: npx tsx scripts/diagnose-tutor.ts <schoolId> <tutorUid>");
  process.exit(1);
}

const ok = (m: string) => console.log(`  [ok]  ${m}`);
const bad = (m: string) => console.log(`  [!!]  ${m}`);
const info = (m: string) => console.log(`        ${m}`);

async function main() {
  // Initialize the Admin SDK inline - same credentials as src/lib/firebase/admin,
  // without its "server-only" import (which doesn't resolve under tsx/node).
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
  const adminAuth = getAuth();

  console.log(`\nDiagnosing tutor\n  schoolId = ${schoolId}\n  tutorUid = ${tutorUid}\n`);

  // 1. Auth user + custom claims -------------------------------------------
  console.log("1. Firebase Auth user & custom claims");
  let claimsSchoolId: unknown;
  try {
    const user = await adminAuth.getUser(tutorUid);
    ok(`user exists (${user.email ?? "no email"})`);
    const claims = user.customClaims ?? {};
    claimsSchoolId = (claims as Record<string, unknown>).schoolId;
    info(`custom claims: ${JSON.stringify(claims)}`);

    if (claimsSchoolId === undefined) {
      bad("no schoolId claim - getTutorSession() would reject and redirect to sign-in.");
    } else if (claimsSchoolId !== schoolId) {
      bad(`schoolId claim (${claimsSchoolId}) != argument (${schoolId}) - the app reads the CLAIM, so the tutor doc is looked up under a different school.`);
    } else {
      ok("schoolId claim matches.");
    }
    if ((claims as Record<string, unknown>).active === false) {
      bad("active claim is false - session is treated as signed out.");
    }
  } catch (e) {
    bad(`no Auth user with that UID (${(e as Error).message}). Copy the exact UID from Console > Authentication > Users.`);
  }

  // 2. ResultPeak tutor profile --------------------------------------------
  // Use the claim's schoolId if present, since that is what the app actually uses.
  //
  // An EMPTY claim counts as absent, not as a school. `typeof "" === "string"`
  // is true, so testing the type alone let a `schoolId: ""` claim win over the
  // argument and build the path `schools//tutors/{uid}`, which Firestore rejects
  // outright - crashing this script on precisely the misconfigured account it
  // exists to diagnose. The app never hits that path: claimRefusal() rejects the
  // account for `active: false` or the missing school before any lookup.
  const effectiveSchoolId =
    typeof claimsSchoolId === "string" && claimsSchoolId !== ""
      ? claimsSchoolId
      : schoolId;
  if (claimsSchoolId === "") {
    info(`claim schoolId is empty - falling back to the argument (${schoolId}).`);
  }
  const tutorPath = `${RP.tutors(effectiveSchoolId)}/${tutorUid}`;
  console.log(`\n2. ResultPeak tutor profile  (${tutorPath})`);

  const tutorSnap = await adminDb.doc(tutorPath).get();
  let assigned: string[] = [];
  if (!tutorSnap.exists) {
    bad("tutor document does NOT exist at this path.");
    info("Either the UID isn't this tutor's ResultPeak id, or the schoolId is wrong.");
  } else {
    ok("tutor document exists.");
    const data = tutorSnap.data() ?? {};
    const raw = (data as Record<string, unknown>).assignedClasses;
    if (!Array.isArray(raw) || raw.length === 0) {
      bad(`assignedClasses is ${JSON.stringify(raw ?? null)} - nothing assigned. Assign classes to this tutor in ResultPeak.`);
    } else {
      assigned = raw as string[];
      ok(`assignedClasses has ${assigned.length} id(s): ${JSON.stringify(assigned)}`);
    }
  }

  // 2b. Subject allocation, and which path the guards will take ------------
  //
  // The deploy-safety check for (class, subject) scoping. An unallocated tutor
  // must take the legacy path through every new guard - see isUnallocated() in
  // src/lib/auth/subject-access.ts. This prints which path a REAL profile takes,
  // which is the thing worth knowing before merging, not after.
  console.log("\n2b. Subject allocation  (class, subject scoping)");
  if (!tutorSnap.exists) {
    info("skipped - no tutor document.");
  } else {
    const data = (tutorSnap.data() ?? {}) as Record<string, unknown>;
    const assignments = data.assignments;
    const subjectClasses = (data.subjectClasses ?? {}) as Record<string, string[]>;
    const assignedSubjects = (data.assignedSubjects ?? []) as string[];

    // Mirrors isUnallocated() exactly: the DERIVED fields, not `assignments`.
    const unallocated =
      assignedSubjects.length === 0 || Object.keys(subjectClasses).length === 0;

    if (unallocated) {
      ok("LEGACY path - not allocated yet, so every subject check passes.");
      info("This is the safe state. Behaviour is identical to class-only scoping.");
      if (Array.isArray(assignments) && assignments.length > 0) {
        bad(
          `but 'assignments' has ${assignments.length} entry/entries while the derived fields are empty.`
        );
        info(
          "ResultPeak has written the allocation but not derived subjectClasses/assignedSubjects."
        );
        info("JDSmartLearn fails OPEN here on purpose, so nothing is locked out.");
      }
    } else {
      ok(`ALLOCATED - subject checks are enforced for this tutor.`);
      info(`assignedSubjects: ${JSON.stringify(assignedSubjects)}`);
      for (const [subjectId, classIds] of Object.entries(subjectClasses)) {
        info(`  ${subjectId} -> ${JSON.stringify(classIds)}`);
      }
      // A pair naming a class outside assignedClasses can never be used, because
      // assertClassAccess runs first.
      const orphans = Object.entries(subjectClasses).flatMap(([s, ids]) =>
        (ids ?? []).filter((id) => !assigned.includes(id)).map((id) => `${s}/${id}`)
      );
      if (orphans.length > 0) {
        bad(`pairs naming a class not in assignedClasses: ${JSON.stringify(orphans)}`);
        info("assertClassAccess runs first, so these are unusable. Fix in ResultPeak.");
      }
    }
    const classTeacherOf = data.classTeacherOf;
    if (Array.isArray(classTeacherOf) && classTeacherOf.length > 0) {
      info(`classTeacherOf: ${JSON.stringify(classTeacherOf)} (read here, used nowhere)`);
    }
  }

  // 3. Do those class ids resolve in `classes`? ----------------------------
  console.log(`\n3. Class documents  (${RP.classes}/<id>)`);
  if (assigned.length === 0) {
    info("skipped - no ids to check.");
  } else {
    for (const id of assigned.slice(0, 30)) {
      const snap = await adminDb.doc(`${RP.classes}/${id}`).get();
      if (!snap.exists) {
        bad(`${id} - not found (getClassesByIds drops it, so it won't show).`);
      } else {
        const c = snap.data() ?? {};
        const name = (c as Record<string, unknown>).className ?? "(no className)";
        const cSchool = (c as Record<string, unknown>).schoolId;
        ok(`${id} - "${name}"${cSchool && cSchool !== effectiveSchoolId ? `  (schoolId ${cSchool} != tutor's)` : ""}`);
      }
    }
  }

  // Verdict ----------------------------------------------------------------
  console.log("\nVerdict");
  const resolvedCount = assigned.length; // detailed per-id status printed above
  if (!tutorSnap.exists) {
    info("Fix the UID/schoolId mismatch, or create the tutor profile in ResultPeak.");
  } else if (resolvedCount === 0) {
    info("Assign classes to this tutor in ResultPeak (or, for dev, add an assignedClasses array on the tutor doc in the Firebase console).");
  } else {
    info("assignedClasses is populated. If the dashboard is still empty, check the per-id results above for classes that don't exist or belong to another school.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
