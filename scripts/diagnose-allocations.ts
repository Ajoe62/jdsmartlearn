/**
 * Read-only: find every tutor whose subject pickers will be wrong, before a
 * teacher finds it for you.
 *
 * Writes NOTHING. For one school, or every school when no id is given, it reads
 * the school's subject list, its classes and its tutors, and reports:
 *
 *   [!!] a class a tutor holds but has no subject allocated in - the subject
 *        box for that class lists every subject (enforcement off) or none (on).
 *        This is what broke Nursery 1 at Mt Cedar on 2026-09-12. The fix is in
 *        ResultPeak: allocate the tutor's subjects there, or remove the class.
 *   [!!] allocated pairs naming a class the tutor no longer holds, or a subject
 *        the school no longer has - unusable, silently dropped from pickers
 *   [!!] `assignments` disagreeing with the derived `subjectClasses`
 *   [..] classes whose curriculum level cannot be worked out from the name, so
 *        topics are not narrowed by level for them (nursery, "Class", ...)
 *
 * The picker judgement comes from the SAME pure function the pages call,
 * pickerAllocation(), so this cannot drift into its own idea of the rules.
 *
 *   npm run diagnose:allocations -- [schoolId]
 */
import process from "node:process";

// Load creds before touching firebase-admin. The Admin SDK is initialised inline
// rather than through src/lib/firebase/admin, whose "server-only" guard only
// resolves inside the Next bundler.
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
import { isUnallocated, pickerAllocation } from "../src/lib/auth/subject-access";
import { classLevel } from "../src/lib/class-level";

const onlySchool = process.argv[2];

const bad = (m: string) => console.log(`    [!!]  ${m}`);
const note = (m: string) => console.log(`    [..]  ${m}`);

interface TutorDoc {
  name?: string;
  assignedClasses?: string[];
  assignedSubjects?: string[];
  subjectClasses?: Record<string, string[]>;
  assignments?: { classId: string; subjectId: string }[];
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

  const schoolSnaps = onlySchool
    ? [await db.doc(`${RP.schools}/${onlySchool}`).get()]
    : (await db.collection(RP.schools).limit(QUERY_LIMIT).get()).docs;

  let problems = 0;

  for (const school of schoolSnaps) {
    if (!school.exists) {
      console.log(`\nNo school with id ${school.id}.`);
      continue;
    }
    const data = school.data() ?? {};
    const subjects = ((data.subjects ?? []) as { id: string; name: string }[]).map((s) => s.id);
    const enforced = data.subjectAllocation === true;

    const classSnap = await db
      .collection(RP.classes)
      .where("schoolId", "==", school.id)
      .limit(QUERY_LIMIT)
      .get();
    const className = new Map(
      classSnap.docs.map((c) => [c.id, String(c.data().name ?? c.id)])
    );
    const name = (id: string) => className.get(id) ?? `${id} (not a class here)`;

    const tutorSnap = await db.collection(RP.tutors(school.id)).limit(QUERY_LIMIT).get();

    console.log(
      `\n${data.name ?? school.id} (${school.id})` +
        `\n  ${subjects.length} subjects, ${classSnap.size} classes, ${tutorSnap.size} tutors,` +
        ` subject enforcement ${enforced ? "ON" : "off"}`
    );

    const noLevel = classSnap.docs
      .filter((c) => !classLevel(c.data() as { name?: string }))
      .map((c) => `"${c.data().name}"`);
    if (noLevel.length > 0) {
      note(`no curriculum level for ${noLevel.join(", ")} - topics are not narrowed by level there`);
    }

    for (const tutor of tutorSnap.docs) {
      const t = tutor.data() as TutorDoc;
      const held = t.assignedClasses ?? [];
      const allocation = {
        isAdmin: false,
        assignedSubjects: t.assignedSubjects ?? [],
        subjectClasses: t.subjectClasses ?? {},
        subjectAllocationEnforced: enforced,
      };
      const findings: string[] = [];

      if (isUnallocated(allocation)) {
        if ((t.assignments ?? []).length > 0) {
          findings.push(
            `'assignments' has ${t.assignments!.length} pair(s) but subjectClasses/assignedSubjects are empty`
          );
        }
      } else {
        const { unmatched } = pickerAllocation(allocation, subjects, held);
        for (const id of unmatched.classIds) {
          findings.push(
            `holds ${name(id)} but has no subject there - the subject box ${
              enforced ? "is EMPTY (they can add nothing)" : "lists every subject"
            }. Fix in ResultPeak: allocate their subjects for it, or remove the class.`
          );
        }

        const pairs = Object.entries(allocation.subjectClasses);
        const unheld = [
          ...new Set(pairs.flatMap(([, ids]) => (ids ?? []).filter((id) => !held.includes(id)))),
        ];
        if (unheld.length > 0) {
          findings.push(`allocated in class(es) they do not hold: ${unheld.map(name).join(", ")}`);
        }
        const gone = pairs.map(([s]) => s).filter((s) => !subjects.includes(s));
        if (gone.length > 0) {
          findings.push(`allocated subject(s) the school no longer lists: ${gone.join(", ")}`);
        }

        const derived = new Set(
          pairs.flatMap(([s, ids]) => (ids ?? []).map((c) => `${s}|${c}`))
        );
        const authored = new Set((t.assignments ?? []).map((a) => `${a.subjectId}|${a.classId}`));
        const drift =
          [...authored].filter((p) => !derived.has(p)).length +
          [...derived].filter((p) => !authored.has(p)).length;
        if (drift > 0) {
          findings.push(`'assignments' and subjectClasses disagree on ${drift} pair(s)`);
        }
      }

      if (findings.length > 0) {
        problems += findings.length;
        console.log(`  ${t.name ?? "(no name)"}  ${tutor.id}`);
        findings.forEach(bad);
      }
    }
  }

  console.log(
    problems === 0
      ? "\nNo allocation problems found.\n"
      : `\n${problems} problem(s) found. Each is fixed in ResultPeak, not here.\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
