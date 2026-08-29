import Wordmark from "@/components/ui/Wordmark";

/**
 * What a hostname nobody has set up looks like.
 *
 * NAMES NO SCHOOL AND LISTS NO TENANTS, and that is the whole specification.
 * Anybody may point a DNS record at this deployment, so this page is reachable
 * by a stranger who has done exactly that. A helpful "did you mean Capstone
 * Academy?" would turn it into a directory of every school on the platform,
 * enumerable by anyone with a domain and five minutes - a competitor's prospect
 * list and an attacker's target list. The same reasoning is why ResultPeak's
 * rules allow `get` on schoolDomains and deny `list`.
 *
 * It also says nothing about whether the address is unknown, misspelled or
 * retired. Those are different facts about a real school, and distinguishing
 * them out loud is the same leak in a smaller font.
 *
 * The product lockup is fine here: this is not a school's page, and it is the
 * one screen where the honest answer is that the visitor has reached us rather
 * than anybody's school.
 */
export default function NotSetUp() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-readable flex-col justify-center px-5 py-16">
      <Wordmark size="md" />
      <h1 className="mt-8 text-title">This address is not set up</h1>
      <p className="mt-3 text-muted">
        Nothing is using this web address yet. Check the address with whoever gave
        it to you, then try again.
      </p>
      <p className="mt-6 text-sm text-muted">
        If your school gave you a link, open that link instead.
      </p>
    </main>
  );
}
