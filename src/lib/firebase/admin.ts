import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Admin SDK singleton. Bypasses security rules - every route using it MUST
 * perform its own authorization check. See CLAUDE.md.
 */
function app(): App {
  const existing = getApps();
  if (existing.length) return existing[0];

  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!privateKey || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PROJECT_ID) {
    throw new Error("Missing Firebase Admin credentials. Copy .env.example to .env.local.");
  }

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

export const adminDb = getFirestore(app());
export const adminAuth = getAuth(app());
