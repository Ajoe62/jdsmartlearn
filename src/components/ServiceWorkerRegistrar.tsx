"use client";

import { useEffect } from "react";
import { flush } from "@/lib/offline/outbox";
import { flushSubmissions } from "@/lib/offline/submissions";

/**
 * Registers the service worker and relays its Background Sync nudge.
 *
 * Registration is deliberately quiet: no install prompt, no "add to home screen"
 * nag. Students share phones, so being installed is not obviously a favour.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "FLUSH_OUTBOX") void flush();
      if (e.data?.type === "FLUSH_SUBMISSIONS") void flushSubmissions();
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    // Register after load so it never competes with the first paint on a slow phone.
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Unsupported, or blocked in private mode. The app works without it -
        // it just has no offline shell.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  return null;
}
