"use client";
import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { assertFirebaseConfig } from "./env";

/**
 * Client SDK - used ONLY for tutor sign-in (to obtain an ID token).
 * All data access goes through server routes. Do not query Firestore
 * from the client: authorization and quota control live on the server.
 *
 * EVERY VALUE IS WRITTEN OUT LITERALLY, AND IT HAS TO BE. Next inlines
 * `process.env.NEXT_PUBLIC_*` at BUILD time by matching that exact text in the
 * source. A loop over an array of variable names would compile to
 * `process.env[name]`, which nothing replaces, so it is `undefined` in the
 * browser and the app fails at sign-in with a Firebase error naming none of
 * this. The repetition below is the price of the inlining and is not tidiable.
 *
 * There is no `storageBucket` and no `messagingSenderId`, deliberately.
 * Firebase Storage is forbidden here - it would force the shared project onto
 * Blaze (CLAUDE.md) - and nothing in this product sends a push. A variable
 * added "for completeness" is a variable the next person has to be told is
 * unused.
 */
const config = assertFirebaseConfig("client", {
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
});

export const clientAuth = getAuth(
  getApps().length
    ? getApp()
    : initializeApp({
        apiKey: config.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: config.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: config.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        appId: config.NEXT_PUBLIC_FIREBASE_APP_ID,
      })
);
