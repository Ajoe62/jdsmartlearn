"use client";
import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

/**
 * Client SDK - used ONLY for tutor sign-in (to obtain an ID token).
 * All data access goes through server routes. Do not query Firestore
 * from the client: authorization and quota control live on the server.
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

export const clientAuth = getAuth(getApps().length ? getApp() : initializeApp(config));
