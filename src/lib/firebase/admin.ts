import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { assertFirebaseConfig } from "./env";

/**
 * Admin SDK singleton. Bypasses security rules - every route using it MUST
 * perform its own authorization check. See CLAUDE.md.
 *
 * THE PROJECT ID COMES FROM THE ENVIRONMENT AND HAS NO FALLBACK. It names the
 * same project in every deployment today and that is not expected to change,
 * but it is configuration rather than source: a value baked in here
 * pins every future deployment to one project, and - far worse - a
 * misconfigured environment would silently keep writing to the project a
 * paying school runs its exams on instead of failing. `assertFirebaseConfig`
 * throws naming the variables, and scripts/test-offline.ts fails the build if
 * the literal id reappears in a tracked file.
 */
function app(): App {
  const existing = getApps();
  if (existing.length) return existing[0];

  const config = assertFirebaseConfig("admin", {
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  });

  return initializeApp({
    credential: cert({
      projectId: config.FIREBASE_PROJECT_ID,
      clientEmail: config.FIREBASE_CLIENT_EMAIL,
      // Pasted into .env with literal \n escapes, wrapped in quotes.
      privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}

export const adminDb = getFirestore(app());
export const adminAuth = getAuth(app());
