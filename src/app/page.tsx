import Link from "next/link";

export default function Home() {
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
          I'm a teacher
        </Link>
        <Link
          href="/student"
          className="rounded-lg border border-line bg-chalk px-5 py-3 text-center font-medium"
        >
          I'm a student
        </Link>
      </div>
    </main>
  );
}
