import { ButtonLink } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-readable px-5 py-16">
      <h1 className="text-title">We can&apos;t find that page</h1>
      <p className="mt-2 text-muted">
        It may have been removed, or the link may be wrong.
      </p>
      <ButtonLink href="/" size="lg" className="mt-6">
        Go to the start
      </ButtonLink>
    </main>
  );
}
