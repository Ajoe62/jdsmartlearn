import Link from "next/link";
import { resultPeakStaffUrl } from "@/lib/partner-links";

export default function Home() {
  // "" when ResultPeak is not configured, and then the row below is not rendered
  // at all. See src/lib/partner-links.ts for why there is no third state.
  const resultPeak = resultPeakStaffUrl();

  return (
    <main className="mx-auto max-w-readable px-5 py-16">
      <h1>
        {/* eslint-disable-next-line @next/next/no-img-element -- local SVG, no optimization needed */}
        <img src="/logo-stacked.svg" alt="JDSmartLearn" width={150} height={118} />
      </h1>
      <p className="mt-6 text-slate">
        Upload a lesson. Get a student summary and practice questions back in minutes.
      </p>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/tutor"
          className="rounded-lg bg-marker px-5 py-3 text-center font-medium text-chalk"
        >
          I&rsquo;m a teacher
        </Link>
        <Link
          href="/student"
          className="rounded-lg border border-line bg-chalk px-5 py-3 text-center font-medium"
        >
          I&rsquo;m a student
        </Link>
      </div>

      {resultPeak && (
        <p className="mt-8 border-t border-line pt-6 text-sm text-slate">
          Looking for exams, scores or a report card?{" "}
          {/* An external product on another domain, so a plain anchor rather
              than next/link, which is for routes inside this app. */}
          <a
            className="font-medium underline"
            href={resultPeak}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open ResultPeak
          </a>
          .
        </p>
      )}
    </main>
  );
}
