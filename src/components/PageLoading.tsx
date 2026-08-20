/** Lightweight loading state - pure CSS, no client JS, safe on slow networks. */
export default function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <main className="mx-auto max-w-readable px-5 py-16">
      <div className="flex items-center gap-3 text-muted" role="status" aria-live="polite">
        <span
          aria-hidden
          className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand"
        />
        <span>{label}</span>
      </div>
    </main>
  );
}
