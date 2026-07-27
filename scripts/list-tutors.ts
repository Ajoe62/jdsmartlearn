/**
 * Read-only: list every tutor in a school with their assigned classes, so you
 * can pick a valid test login in one command.
 *
 * Writes NOTHING. Reads schools/{schoolId}/tutors, then batch-resolves each
 * tutor's Auth email and their class names for readability.
 *
 *   npx tsx scripts/list-tutors.ts <schoolId>
 *
 * schoolId - the school to list (a tutor's schoolId custom claim).
 */
import process from "node:process";

// Load creds before touching firebase-admin. We init the Admin SDK directly
// (below) rather than importing src/lib/firebase/admin, which pulls in Next's
// "server-only" guard - that module only resolves inside the Next bundler.
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
import { RP, QUERY_LIMIT } from "../src/lib/db/collections";

const schoolId = process.argv[2];
if (!schoolId) {
  console.error("Usage: npx tsx scripts/list-tutors.ts <schoolId>");
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
  const adminAuth = getAuth();

  console.log(`\nTutors in school ${schoolId}\n`);

  const snap = await adminDb
    .collection(RP.tutors(schoolId))
    .limit(QUERY_LIMIT)
    .get();

  if (snap.empty) {
    console.log("  No tutor documents under schools/" + schoolId + "/tutors.");
    console.log("  This school has no tutors yet - they're created in ResultPeak, not here.\n");
    return;
  }

  const tutors = snap.docs.map((d) => {
    const data = (d.data() ?? {}) as Record<string, unknown>;
    const assigned = Array.isArray(data.assignedClasses)
      ? (data.assignedClasses as string[])
      : [];
    return {
      uid: d.id,
      name: typeof data.name === "string" ? data.name : "(no name)",
      assigned,
    };
  });

  // Batch-resolve class names (one getAll for the union of all class ids).
  const classIds = [...new Set(tutors.flatMap((t) => t.assigned))];
  const classNames = new Map<string, string>();
  if (classIds.length) {
    const refs = classIds.slice(0, 100).map((id) => adminDb.doc(`${RP.classes}/${id}`));
    const classSnaps = await adminDb.getAll(...refs);
    for (const c of classSnaps) {
      if (c.exists) {
        const cd = (c.data() ?? {}) as Record<string, unknown>;
        classNames.set(c.id, (cd.name as string) ?? (cd.className as string) ?? c.id);
      }
    }
  }

  // Batch-resolve emails (getUsers takes up to 100 identifiers per call).
  const emails = new Map<string, string>();
  const identifiers = tutors.slice(0, 100).map((t) => ({ uid: t.uid }));
  if (identifiers.length) {
    const result = await adminAuth.getUsers(identifiers);
    for (const u of result.users) emails.set(u.uid, u.email ?? "(no email)");
  }

  for (const t of tutors) {
    const email = emails.get(t.uid) ?? "(no Auth user)";
    console.log(`- ${t.name}  <${email}>`);
    console.log(`    uid: ${t.uid}`);
    if (t.assigned.length === 0) {
      console.log(`    classes: none assigned  ->  tutor dashboard will be empty`);
    } else {
      const labels = t.assigned.map((id) => {
        const name = classNames.get(id);
        return name ? `${name} (${id})` : `${id} [not found in classes]`;
      });
      console.log(`    classes: ${labels.join(", ")}`);
    }
  }

  const withClasses = tutors.filter((t) => t.assigned.length > 0);
  console.log(`\n${tutors.length} tutor(s), ${withClasses.length} with at least one class.`);
  if (withClasses.length) {
    console.log(`Good test login: ${withClasses[0].name} (uid ${withClasses[0].uid}).`);
    console.log(`Verify: npm run diagnose:tutor -- ${schoolId} ${withClasses[0].uid}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
