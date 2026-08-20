"use client";

import { useEffect, useState } from "react";
import DashboardView from "@/components/student/DashboardView";
import LessonReaderView from "@/components/student/LessonReaderView";

/**
 * The offline app shell.
 *
 * The service worker serves THIS page's HTML for any /student/* navigation it
 * cannot fetch. The HTML therefore has to be data-free - it is shared by every
 * student who ever uses this phone, so baking a lesson list into it would leak
 * one student's content to the next.
 *
 * Instead it reads the real URL and hands off to the same view components the
 * server-rendered pages use, which read IndexedDB when given no data.
 */
export default function OfflineShell() {
  const [route, setRoute] = useState<
    { kind: "dashboard" } | { kind: "lesson"; id: string } | null
  >(null);

  useEffect(() => {
    // The SW responds to /student/lessons/abc with this document, so the path is
    // the real one the student asked for - not /student/offline.
    const match = /^\/student\/lessons\/([^/?#]+)/.exec(window.location.pathname);
    setRoute(match ? { kind: "lesson", id: decodeURIComponent(match[1]) } : { kind: "dashboard" });
  }, []);

  if (!route) {
    return (
      <main className="mx-auto max-w-readable px-5 py-10">
        <p className="text-muted">Opening your lessons…</p>
      </main>
    );
  }

  if (route.kind === "lesson") {
    return <LessonReaderView lessonId={route.id} initial={null} />;
  }

  return <DashboardView initial={null} />;
}
