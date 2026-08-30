import "server-only";
import { unstable_cache } from "next/cache";
import { adminDb } from "@/lib/firebase/admin";
import { RP } from "./collections";
import {
  THIS_PRODUCT,
  normaliseHostname,
  normaliseProduct,
  parsePlatformHosts,
  printableAddress,
  type SchoolDomainMapping,
  type SchoolDomainProduct,
} from "@/lib/routing/hostname";

/**
 * Reading `schoolDomains`. READ ONLY - ResultPeak owns every write.
 *
 * Two shapes, and they are deliberately different:
 *
 *   lookupSchoolDomain   hostname -> school. A DOCUMENT GET, because the
 *                        document id is the normalised hostname. No query, no
 *                        index, one read.
 *
 *   schoolAddresses      school -> its addresses. A query, needed only to PRINT
 *                        an address on a sign-in sheet.
 *
 * Both are cached, and on a Spark plan shared with a live school's exam day
 * that is not a nicety. The lookup runs on requests to a school's own hostname;
 * without a cache that is one Firestore read per page view of every signed-out
 * visitor, for a document that changes about never.
 */

/** Long, because a hostname mapping changes when a school buys a domain. */
const REVALIDATE_SECONDS = 900;

/**
 * A ceiling on one school's addresses. Mirrors MAX_DOMAINS_PER_SCHOOL in
 * ResultPeak's domainActions.js: a school with 25 addresses has a problem no cap
 * will fix, and every query in this repo carries an explicit limit (CLAUDE.md).
 */
const MAX_DOMAINS_PER_SCHOOL = 25;

/**
 * The mapping for a hostname, or null.
 *
 * The caller must pass an ALREADY NORMALISED hostname - it is normalised again
 * here anyway, because this is the last point before a value from the address
 * bar becomes a Firestore document path, and a hostname that does not normalise
 * would build a malformed path.
 *
 * Returns null for an inactive mapping as well as a missing one. `active:false`
 * is how ResultPeak retires an address without deleting the row that records it
 * ever existed, and treating it as live would resurrect an address a school has
 * moved off.
 *
 * `product` IS DELIBERATELY NOT FILTERED HERE, and that is a decision rather
 * than an omission. DNS already chose which app answers this hostname: a
 * request only reaches this deployment because a record points here. A row
 * labelled for the other product is therefore a mislabelled row, and refusing
 * to resolve it would show the not-set-up page to a school whose address is
 * working perfectly, for a field no visitor can see. The product decides what
 * this repo PRINTS (printableSchoolAddress below) and nothing else.
 */
export function lookupSchoolDomain(hostname: string): Promise<SchoolDomainMapping | null> {
  const host = normaliseHostname(hostname);
  if (!host) return Promise.resolve(null);

  return unstable_cache(
    async (): Promise<SchoolDomainMapping | null> => {
      const snap = await adminDb.doc(`${RP.schoolDomains}/${host}`).get();
      if (!snap.exists) return null;

      const schoolId = String(snap.get("schoolId") ?? "").trim();
      if (!schoolId) return null;

      // Strict !== false: absent means active, matching every other read of this
      // field in the codebase.
      if (snap.get("active") === false) return null;

      return {
        schoolId,
        active: true,
        isPrimary: snap.get("isPrimary") === true,
        product: normaliseProduct(snap.get("product")),
      };
    },
    ["school-domain", host],
    { revalidate: REVALIDATE_SECONDS, tags: [`school-domain:${host}`] }
  )();
}

/**
 * Every address a school holds, for printing one.
 *
 * ONE EQUALITY FILTER, ON PURPOSE. Filtering `isPrimary` in Firestore as well
 * would be two equality filters on different fields, which needs a COMPOSITE
 * INDEX - and this repo may not deploy indexes, so it would mean a pull request
 * against ResultPeak's project-level index file before a sign-in sheet could
 * print an address. A school has a handful of addresses; picking the primary
 * out of them in memory costs nothing and keeps the whole feature inside what
 * this repo can ship on its own.
 */
export function schoolAddresses(
  schoolId: string
): Promise<
  { hostname: string; active: boolean; isPrimary: boolean; product: SchoolDomainProduct }[]
> {
  if (!schoolId) return Promise.resolve([]);

  return unstable_cache(
    async () => {
      const snap = await adminDb
        .collection(RP.schoolDomains)
        .where("schoolId", "==", schoolId)
        .limit(MAX_DOMAINS_PER_SCHOOL)
        .get();

      return snap.docs.map((d) => ({
        hostname: d.id,
        active: d.get("active") !== false,
        isPrimary: d.get("isPrimary") === true,
        // Same reason the isPrimary filter is done in memory: a second equality
        // filter would need a composite index, and this repo may not deploy one.
        product: normaliseProduct(d.get("product")),
      }));
    },
    ["school-addresses", schoolId],
    { revalidate: REVALIDATE_SECONDS, tags: [`school-addresses:${schoolId}`] }
  )();
}

/**
 * The one address to write on a printed sign-in sheet, or "".
 *
 * "" is a normal answer, not a failure: it is what every school gets until it
 * has an address of its own, and callers fall back to the shared domain and
 * /s/{slug}, which is what they printed before this feature existed. It is also
 * what a school gets when it has a ResultPeak address and no lessons one, which
 * is the correct answer rather than a near miss: printing the exam portal on a
 * lessons card would send a child to the wrong site.
 *
 * THIS_PRODUCT, always. This collection holds both apps' addresses.
 */
export async function primaryAddress(schoolId: string): Promise<string> {
  return printableAddress(await schoolAddresses(schoolId), THIS_PRODUCT);
}

/**
 * The whole address to print on a class sign-in sheet.
 *
 * A parent types this off paper, so it has to be complete and it has to work.
 * The order:
 *
 *   1. the school's own PRIMARY address, if it has one
 *   2. this deployment's first configured platform host, plus /s/{slug}
 *   3. the bare /s/{slug} path
 *
 * NEVER THE HOSTNAME THIS REQUEST ARRIVED ON. That is the rule that makes the
 * tier 2 to tier 3 upgrade free: a sheet printed on the free subdomain must not
 * bake that subdomain in, or every sheet has to be reprinted the day the school
 * buys a domain. What is printed is the address the school has NOMINATED
 * (isPrimary), which moves when the school moves, or a platform address that
 * never moves at all.
 *
 * Falling back to a bare path is not a defeat: it is exactly what a sheet said
 * before school addresses existed, and it is still correct on whatever address
 * the reader is already looking at.
 */
export async function printableSchoolAddress(
  schoolId: string,
  slug: string
): Promise<string> {
  const primary = await primaryAddress(schoolId);
  if (primary) return `https://${primary}`;

  const path = `/s/${slug}`;
  const [host] = parsePlatformHosts(process.env.PLATFORM_HOSTS ?? "");
  return host ? `https://${host}${path}` : path;
}
