"use client";

/** Shared error boundary body. Plain words, one clear action. */
export default function PageError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-readable px-5 py-16">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-slate">
        The page didn&apos;t load. It&apos;s not something you did — try again, and if it
        keeps happening, check your connection.
      </p>
      <button
        onClick={reset}
        className="mt-6 rounded-lg bg-marker px-4 py-3 font-medium text-chalk hover:bg-markerDark"
      >
        Try again
      </button>
    </main>
  );
}
