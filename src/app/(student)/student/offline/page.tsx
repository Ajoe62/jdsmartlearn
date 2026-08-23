"use client";

import { useEffect, useState } from "react";
import Announcements from "@/components/student/Announcements";
import DashboardView from "@/components/student/DashboardView";
import LessonReaderView from "@/components/student/LessonReaderView";
import SchemeReaderView from "@/components/student/SchemeReaderView";
import SubjectDetailView from "@/components/student/SubjectDetailView";
import SubjectShelfView from "@/components/student/SubjectShelfView";
import { EMPTY_READ_STATE } from "@/lib/announcements/notices";
import type { ShelfTotals } from "@/lib/shelf/build";

/** All zeroes. Replaced from IndexedDB on mount; never rendered from the HTML. */
const EMPTY_TOTALS: ShelfTotals = {
  due: 0,
  overdue: 0,
  marked: 0,
  lessons: 0,
  subjectsWithWork: 0,
};

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
type Route =
  | { kind: "dashboard" }
  | { kind: "lesson"; id: string }
  | { kind: "subject"; id: string }
  | { kind: "scheme"; id: string };

/**
 * Which offline view a path asks for.
 *
 * Exhaustive by design: anything unrecognised falls back to the dashboard rather
 * than to a blank page, because the service worker serves this document for ANY
 * /student/* navigation it cannot fetch - including routes added later that have
 * no offline view yet.
 */
function routeFor(pathname: string): Route {
  const lesson = /^\/student\/lessons\/([^/?#]+)/.exec(pathname);
  if (lesson) return { kind: "lesson", id: decodeURIComponent(lesson[1]) };

  const subject = /^\/student\/subjects\/([^/?#]+)/.exec(pathname);
  if (subject) return { kind: "subject", id: decodeURIComponent(subject[1]) };

  const scheme = /^\/student\/schemes\/([^/?#]+)/.exec(pathname);
  if (scheme) return { kind: "scheme", id: decodeURIComponent(scheme[1]) };

  return { kind: "dashboard" };
}

export default function OfflineShell() {
  const [route, setRoute] = useState<Route | null>(null);

  useEffect(() => {
    // The SW responds to /student/lessons/abc with this document, so the path is
    // the real one the student asked for - not /student/offline.
    setRoute(routeFor(window.location.pathname));
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

  if (route.kind === "scheme") {
    return <SchemeReaderView schemeId={route.id} initial={null} />;
  }

  if (route.kind === "subject") {
    /**
     * The subject name is not in the URL, only its id. `SubjectDetailView` fills
     * it in from the device store on mount; until then the id is shown, which is
     * ugly for one frame and honest. Marks are empty here on purpose - they are
     * per-child and the assignments page owns their offline path.
     */
    return (
      <SubjectDetailView
        subjectId={route.id}
        subjectName={route.id}
        initialLessons={[]}
        initialSchemes={[]}
        marks={[]}
      />
    );
  }

  /**
   * Empty props, not missing ones. This HTML is shared by every student who ever
   * uses this phone, so it can carry no data at all - every slot reads the device
   * store on mount, and the store is wiped when a different student signs in.
   * `EMPTY_READ_STATE` and the empty shelf are replaced from IndexedDB in the
   * same pass.
   */
  return (
    <DashboardView
      announcements={<Announcements initial={[]} initialReadState={EMPTY_READ_STATE} />}
      shelf={
        <SubjectShelfView
          initial={[]}
          initialTotals={EMPTY_TOTALS}
          initialTerms={[]}
          subjectsIncomplete={false}
          hasUndated={false}
        />
      }
    />
  );
}
