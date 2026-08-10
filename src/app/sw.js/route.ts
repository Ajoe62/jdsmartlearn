/**
 * The service worker, served from a route handler so no build step is needed and
 * the cache version can come from the deployment id.
 *
 * Deliberately hand-written rather than Workbox/Serwist: the whole surface is
 * three caches, one navigation fallback and one deny-list, and the deny-list is
 * the thing that keeps tutor pages - which DO carry marking guides - out of the
 * cache. That has to stay readable at a glance (CLAUDE.md, Offline rules).
 */

function buildId(): string {
  return (
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.npm_package_version ??
    "dev"
  );
}

function script(version: string): string {
  return `// JDSmartLearn service worker - generated, do not edit by hand.
const VERSION = ${JSON.stringify(version)};
const SHELL = "jd-shell-" + VERSION;
const STATIC = "jd-static-" + VERSION;
const FILES = "jd-files-v1";
const OURS = [SHELL, STATIC, FILES];

/** The offline renderer. Data-free, so it is safe on a shared phone. */
const SHELL_URL = "/student/offline";

const PRECACHE = [SHELL_URL, "/student/sign-in", "/manifest.webmanifest", "/logo-horizontal.svg"];

/**
 * NEVER cache these. Tutor pages and the tutor lesson API carry marking guides,
 * and every mutation must reach the server. Checked before any cache write.
 */
function denied(url, request) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith("/tutor")) return true;
  if (url.pathname.startsWith("/api/tutor")) return true;
  // Student sync payloads live in IndexedDB, not here - caching them would put a
  // second, unmanaged copy outside the grace window and the wipe-on-sign-in path.
  if (url.pathname.startsWith("/api/student")) return true;
  // /api/lessons/*/file is allowed (opt-in, saved explicitly); everything else
  // under /api/lessons is tutor surface.
  if (url.pathname.startsWith("/api/lessons")) {
    return !/^\\/api\\/lessons\\/[^/]+\\/file$/.test(url.pathname);
  }
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      // addAll fails the whole install if one entry 404s; add individually so a
      // missing optional asset never blocks the worker.
      Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})))
    )
  );
  // No skipWaiting: forcing a reload on a student mid-read on a bad link is
  // hostile. The new worker takes over on the next full navigation.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("jd-") && !OURS.includes(k)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/** Wipe every cache. Called when a student signs out or is revoked. */
async function purge() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith("jd-")).map((k) => caches.delete(k)));
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "PURGE") event.waitUntil(purge());
});

self.addEventListener("sync", (event) => {
  // One-shot Background Sync: nudge any open tab to flush its queue. If no tab is
  // open the next app open will flush anyway.
  //
  // Two tags, not one. Read receipts are a soft metric; a queued submission is a
  // child's homework. Keeping them separate means a browser that drops one tag
  // has not dropped the other.
  const messages = {
    "jd-outbox": "FLUSH_OUTBOX",
    "jd-submissions": "FLUSH_SUBMISSIONS",
  };
  const message = messages[event.tag];
  if (message) {
    event.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true }).then((cs) => {
        for (const c of cs) c.postMessage({ type: message });
      })
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Navigations: shell-first for the student area.
  //
  // Cache-first rather than network-first on purpose. On a throttled 3G link a
  // network-first timeout is exceeded routinely even when online, so it would
  // feel slow AND still serve the fallback. The shell loads instantly, then the
  // client re-syncs its data.
  if (request.mode === "navigate") {
    if (url.pathname === "/student" || url.pathname.startsWith("/student/")) {
      // Let the real sign-in page through - it must talk to the server.
      if (url.pathname.startsWith("/student/sign-in")) {
        event.respondWith(networkThenCache(request, SHELL));
        return;
      }
      event.respondWith(shellFirst(request));
      return;
    }

    /**
     * Two tutor pages are cacheable so a teacher can compose with no signal: the
     * dashboard (where queued work is shown) and the new-lesson form (which needs
     * the class, subject and topic pickers).
     *
     * NETWORK-FIRST, unlike the student side: a tutor online must see a current
     * class list, and there is no data-free shell to fall back on.
     *
     * The tradeoff, deliberately taken: these cached pages carry the tutor's class
     * and topic names, so a shared phone could show them to the next person before
     * they sign in. That is class metadata, not student data and not a marking
     * guide, and it is wiped on sign-out and on tutor change. Every OTHER /tutor
     * page falls through to network-only below - /tutor/lessons/{id} renders the
     * marking guide and must never be stored.
     */
    if (url.pathname === "/tutor" || url.pathname === "/tutor/lessons/new") {
      event.respondWith(networkThenCache(request, SHELL));
      return;
    }

    return; // Every other tutor page, and marketing: network only.
  }

  if (denied(url, request)) return;

  // Next's immutable build output.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC));
    return;
  }

  // Saved original files, explicitly opted into by the student.
  if (/^\\/api\\/lessons\\/[^/]+\\/file$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, FILES));
    return;
  }

  // Same-origin static assets (logo, icons, fonts).
  if (/\\.(svg|png|ico|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL));
  }
});

async function shellFirst(request) {
  const cache = await caches.open(SHELL);

  // Serve the data-free shell immediately; it renders from IndexedDB.
  const shell = await cache.match(SHELL_URL);
  if (shell) {
    // Refresh the shell in the background so a new deploy lands next time.
    void fetch(SHELL_URL, { cache: "reload" })
      .then((res) => (res.ok ? cache.put(SHELL_URL, res) : null))
      .catch(() => {});
    return shell;
  }

  // First ever visit and nothing cached yet: go to the network.
  try {
    const res = await fetch(request);
    if (res.ok) void cache.put(SHELL_URL, res.clone());
    return res;
  } catch {
    return new Response(offlineHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function networkThenCache(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      void cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(offlineHtml(), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      void cache.put(request, res.clone());
    }
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}

/** Last resort, only before the shell has ever been cached. */
function offlineHtml() {
  return [
    "<!doctype html><html lang=en><meta charset=utf-8>",
    "<meta name=viewport content='width=device-width,initial-scale=1'>",
    "<title>You're offline</title>",
    "<style>body{font:16px system-ui;margin:0;padding:2rem;color:#1f2933}",
    "h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#52606d}</style>",
    "<h1>You're offline</h1>",
    "<p>Connect to the internet once, then your lessons will be saved on your phone.</p>",
    "</html>",
  ].join("");
}
`;
}

export async function GET() {
  return new Response(script(buildId()), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Root scope even though the file is served from /sw.js.
      "Service-Worker-Allowed": "/",
      // Must never be cached, or a deploy could not replace the worker.
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
