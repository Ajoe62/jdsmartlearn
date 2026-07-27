import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-readable px-5 py-16">
      <h1 className="text-xl font-semibold">We can&apos;t find that page</h1>
      <p className="mt-2 text-slate">
        It may have been removed, or the link may be wrong.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-lg bg-marker px-4 py-3 font-medium text-chalk hover:bg-markerDark"
      >
        Go to the start
      </Link>
    </main>
  );
}
