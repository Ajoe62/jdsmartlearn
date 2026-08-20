"use client";

import { Button } from "@/components/ui/Button";

/** Shared error boundary body. Plain words, one clear action. */
export default function PageError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-readable px-5 py-16">
      <h1 className="text-title">Something went wrong</h1>
      <p className="mt-2 text-muted">
        The page didn&apos;t load. It&apos;s not something you did — try again, and if it
        keeps happening, check your connection.
      </p>
      <Button onClick={reset} size="lg" className="mt-6">
        Try again
      </Button>
    </main>
  );
}
