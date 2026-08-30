/**
 * Hostnames, and the one rule that keeps them harmless.
 *
 * ============================================================================
 * A HOSTNAME IS A ROUTING HINT. IT IS NEVER A SECURITY BOUNDARY.
 * ============================================================================
 *
 * Anybody can point a DNS record at this deployment. That costs them nothing,
 * needs no permission from us, and cannot be prevented. So resolving a hostname
 * must GRANT NOTHING. What it does is choose which school's crest and colours a
 * signed-out page wears. That is the whole of it.
 *
 * Every student session is still a signed cookie verified server-side, every
 * tutor session still carries custom claims, and `schoolId` FOR ACCESS PURPOSES
 * COMES FROM THE SESSION, NEVER FROM HERE. A stranger who points their own
 * domain at this app gets a sign-in screen wearing somebody's colours and not
 * one row of data. Those colours are already public: they render on /s/{slug}
 * today, to anyone, signed out.
 *
 * The corollary, and the rule most likely to be broken by accident: THE
 * HOSTNAME IS NEVER STORED. Not on a record, not on a session, not in a token,
 * not on an audit row, not on a printed sign-in card. It is resolved per
 * request and discarded. That is precisely what makes the tier 2 to tier 3
 * upgrade free: a school moving from its free subdomain to a domain it bought
 * changes one document and one DNS record, and nothing written down last term
 * has to be found and rewritten.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A PORT, NOT AN ORIGINAL. The canonical implementation is
 * `src/lib/schoolDomains.js` in the ResultPeak repository, which also owns the
 * WRITE path for `schoolDomains`. The two products share one Firestore database
 * but not one repository, so the code cannot be shared and has to be copied.
 *
 * THE STORED DOCUMENT ID AND THE LOOKUP HERE MUST NORMALISE IDENTICALLY. A
 * school whose document was written as `Portal.School.NG` and is looked up as
 * `portal.school.ng` does not half-work: it silently disappears, and the symptom
 * a school reports is "the website stopped knowing who we are". So if
 * `normaliseHostname` below is ever edited, the same edit belongs in ResultPeak
 * in the same change. See docs/resultpeak-school-domains-prompt.md.
 * ---------------------------------------------------------------------------
 *
 * Pure and dependency-free, so `node --test` exercises every case with no
 * Firebase project - the same treatment as lib/auth/claims.ts and
 * lib/branding/colour.ts, and covered by the same reasoning: this decides what
 * a stranger's DNS record can reach, and it is worth testing against the real
 * function rather than a copy of it.
 */

/**
 * Labels that may never belong to a school.
 *
 * Two kinds of thing. The first is infrastructure: names a mail server, a CDN,
 * a certificate check or a person typing out of habit expects to reach US.
 * Handing `mail.{zone}` to a school breaks that school's own email as well as
 * ours. The second is the product's own vocabulary, so a school cannot end up
 * at `admin.{zone}` or `student.{zone}`.
 *
 * Enforcement belongs at ResultPeak's write path, because ResultPeak creates
 * these documents. This list is the second half of that: a document written by
 * hand in the Firebase console, or by a ResultPeak build that predates its own
 * check, still must not resolve here. Both, not either.
 *
 * Kept in step with RESERVED_HOST_LABELS in ResultPeak's src/lib/schoolDomains.js.
 * Adding to this list is safe; removing from it is not, because a label handed
 * out once is an address somebody printed.
 */
export const RESERVED_HOST_LABELS: ReadonlySet<string> = new Set([
  // Infrastructure and convention.
  "www", "api", "app", "admin", "mail", "email", "webmail", "smtp", "imap",
  "pop", "pop3", "mx", "ns", "ns1", "ns2", "dns", "ftp", "sftp", "vpn",
  "cdn", "assets", "static", "media", "img", "images", "files", "download",
  "status", "health", "monitor", "metrics", "logs", "ci", "git", "registry",
  "autodiscover", "autoconfig", "_domainkey", "dmarc", "spf",
  // Ours specifically.
  "dev", "staging", "stage", "preview", "test", "testing", "demo", "sandbox",
  "beta", "alpha", "internal", "root", "localhost", "vercel", "firebase",
  // The product's own words.
  "auth", "login", "logout", "account", "portal", "dashboard", "exam",
  "exams", "result", "results", "student", "students", "tutor", "tutors",
  "study", "entrance", "apply", "admissions", "applicant", "applicants",
  "school", "schools", "new", "help", "support", "docs", "blog", "about",
  "contact", "privacy", "terms", "billing", "pay", "payments",
]);

/**
 * Hosts that are always the platform itself, whatever else is configured.
 *
 * Every Vercel preview deployment gets its own hostname, so these can never be
 * enumerated in advance and must never be treated as a tenant address that
 * failed to resolve - a preview showing "this address is not set up" would make
 * every preview deployment look broken.
 */
const ALWAYS_PLATFORM: RegExp[] = [
  /^localhost$/,
  /^127\.0\.0\.1$/,
  /^\[?::1\]?$/,
  /^0\.0\.0\.0$/,
  /(^|\.)vercel\.app$/,
  /\.local$/,
  /\.localhost$/,
  /\.test$/,
];

const str = (value: unknown): string => String(value ?? "").trim();

/**
 * The document id for a hostname, or "" if it is not one.
 *
 * The rules, each a decision rather than an accident:
 *
 *   LOWERCASE. Hostnames are case-insensitive; browsers already send them
 *   lowercased, but a hostname typed into an admin form is not.
 *
 *   PORT STRIPPED. `localhost:3000` and `school.example.com:443` are the same
 *   host as far as a mapping is concerned.
 *
 *   TRAILING DOT STRIPPED. `school.example.com.` is the fully-qualified form of
 *   the same name and some clients send it.
 *
 *   LEADING `www.` STRIPPED, EXACTLY ONE. This is the one worth arguing about,
 *   and it is stripped deliberately. `www` is a RESERVED LABEL above, so it can
 *   never be a school's own name; a school pointing both `portal.x.com` and
 *   `www.portal.x.com` at us means one address, not two; and storing two
 *   documents for one address is how one of them goes stale. Stripping is also
 *   the GENEROUS direction, which is safe precisely because a hostname grants
 *   nothing: the worst case of resolving generously is a school seeing its own
 *   page, while not stripping strands a visitor who typed `www.`.
 *
 * Anything that is not a plausible hostname returns "": empty, a path, a
 * scheme, whitespace inside, a label longer than DNS allows. Returning ""
 * rather than throwing matters, because this runs on a value from the address
 * bar on every request.
 */
export function normaliseHostname(value: unknown): string {
  let host = str(value).toLowerCase();
  if (!host) return "";

  // Tolerate a full URL or an origin, so a hostname pasted from an address bar
  // into ResultPeak's admin form gets what the person meant.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Anything from the first "/" onwards is a path, not a host.
  host = host.split("/")[0];
  // Credentials, if somebody pasted an authenticated URL.
  host = host.split("@").pop() ?? "";
  // Port. Bracketed IPv6 is not a school address and falls out as invalid below.
  host = host.replace(/:\d+$/, "");
  // Fully-qualified trailing dot.
  host = host.replace(/\.+$/, "");
  // The one label rewrite, argued for above.
  if (host.startsWith("www.")) host = host.slice(4);

  if (!host || host.length > 253) return "";
  // Firestore document ids may not contain "/" and may not be "." or ".."; a
  // hostname matching this expression can be none of those.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return "";
  }
  if (host.split(".").some((label) => label.length > 63)) return "";

  return host;
}

/** How this deployment knows its own addresses. Both halves are optional. */
export interface PlatformConfig {
  /** The zone free school subdomains sit under. The apex is ours. */
  zone?: string;
  /** This deployment's own hostnames. */
  platformHosts?: string[];
}

/**
 * True when this hostname is the product itself rather than a school's address.
 *
 * Development, Vercel previews and the shared domain all land here, and they
 * all behave exactly as they did before this feature existed: no lookup, no
 * hostname branding, /s/{slug} and the school cookie decide. A platform host is
 * NEVER shown the not-set-up page, because the platform is very much set up.
 */
export function isPlatformHost(hostname: unknown, config: PlatformConfig = {}): boolean {
  const { platformHosts = [], zone = "" } = config;
  const host = normaliseHostname(hostname);
  if (!host) return true; // no hostname at all is not a tenant address

  if (ALWAYS_PLATFORM.some((pattern) => pattern.test(host))) return true;

  const cleanZone = normaliseHostname(zone);
  if (cleanZone && host === cleanZone) return true;

  return platformHosts
    .map((entry) => normaliseHostname(entry))
    .filter(Boolean)
    .includes(host);
}

/** True when `hostname` sits directly beneath the free-subdomain zone. */
export function isInZone(hostname: unknown, zone: unknown): boolean {
  const host = normaliseHostname(hostname);
  const cleanZone = normaliseHostname(zone);
  if (!host || !cleanZone || host === cleanZone) return false;
  return host.endsWith(`.${cleanZone}`);
}

/**
 * The label a school would occupy in the zone, or "" when the hostname is not a
 * single label beneath it.
 *
 * FOR VALIDATION ONLY. Nothing may resolve a school from this. The label is
 * looked up as part of a whole hostname, like every other address; parsing a
 * label into an identity is what would turn a DNS record into a permission, and
 * it is the single thing this module exists to prevent.
 */
export function zoneLabel(hostname: unknown, zone: unknown): string {
  if (!isInZone(hostname, zone)) return "";
  const host = normaliseHostname(hostname);
  const cleanZone = normaliseHostname(zone);
  const prefix = host.slice(0, -(cleanZone.length + 1));
  return prefix.includes(".") ? "" : prefix;
}

/**
 * True when a hostname takes one of OUR reserved names and must not resolve.
 *
 * SCOPED TO THE ZONE, and that scoping is deliberate rather than a weakening.
 * `admin.someschool.com` is the school's own business and none of ours -
 * refusing it would break a legitimate purchased domain for no gain, since the
 * label grants nothing either way. `admin.{zone}` is an address we need, and a
 * school must never hold it.
 *
 * A bare reserved label with no domain (`admin`) is refused too. It cannot
 * reach a browser as a real address, but it can reach a hand-written Firestore
 * document, and this is the cheaper place to stop it.
 */
export function isReservedHost(hostname: unknown, config: PlatformConfig = {}): boolean {
  const host = normaliseHostname(hostname);
  if (!host) return false;

  if (!host.includes(".")) return RESERVED_HOST_LABELS.has(host);

  const label = zoneLabel(host, config.zone ?? "");
  return label ? RESERVED_HOST_LABELS.has(label) : false;
}

/**
 * Which app an address answers for.
 *
 * ResultPeak and JDSmartLearn are separate Vercel projects, so one hostname
 * cannot serve both, and a school using both holds TWO addresses. Both are
 * written by ResultPeak, which owns this collection; this repo only reads.
 *
 * An ABSENT value means "resultpeak", because ResultPeak owns the only write
 * path the collection has ever had, so every row predating the field is one of
 * its own. That is what lets the two repos deploy in either order: deployed
 * first, this side finds no jdsmartlearn address and falls back to the platform
 * host plus /s/{slug}, which is what sign-in sheets printed before school
 * addresses existed.
 *
 * It decides what is PRINTED and nothing else. See lookupSchoolDomain.
 */
export const SCHOOL_DOMAIN_PRODUCTS = ["resultpeak", "jdsmartlearn"] as const;
export type SchoolDomainProduct = (typeof SCHOOL_DOMAIN_PRODUCTS)[number];
export const DEFAULT_DOMAIN_PRODUCT: SchoolDomainProduct = "resultpeak";

/** This repo's own product, so no caller has to spell it as a bare string. */
export const THIS_PRODUCT: SchoolDomainProduct = "jdsmartlearn";

/**
 * A stored product value, as one of SCHOOL_DOMAIN_PRODUCTS.
 *
 * Falls back rather than throwing: this runs over data read back from
 * Firestore, where a value nobody expected must still produce a printable
 * address instead of a broken sign-in sheet. ResultPeak's write path is where a
 * bad value is refused.
 */
export function normaliseProduct(value: unknown): SchoolDomainProduct {
  const clean = String(value ?? "").trim().toLowerCase();
  return (SCHOOL_DOMAIN_PRODUCTS as readonly string[]).includes(clean)
    ? (clean as SchoolDomainProduct)
    : DEFAULT_DOMAIN_PRODUCT;
}

/** What a `schoolDomains/{hostname}` document holds. ResultPeak writes these. */
export interface SchoolDomainMapping {
  schoolId: string;
  active: boolean;
  isPrimary: boolean;
  product: SchoolDomainProduct;
}

/** The three things a request's hostname can mean. Nothing here grants access. */
export type HostMode = "platform" | "school" | "unmapped";

export interface HostVerdict {
  mode: HostMode;
  /** Normalised, for logging and lookups. NEVER stored on anything. */
  hostname: string;
  /** Branding only. Access still comes from the session, always. */
  schoolId: string;
}

/**
 * What the app should do about the hostname this request arrived on.
 *
 *   "platform"  the shared domain, localhost, a Vercel preview. Behave exactly
 *               as before this feature existed: /s/{slug} and the school cookie
 *               choose the school, or nobody does.
 *   "school"    a hostname with a live mapping. Wear this school's branding.
 *               Access is still decided by the session, every time.
 *   "unmapped"  a hostname nobody has set up. Show the plain not-set-up page,
 *               which names no school and lists no tenants.
 *
 * `mapping` is what the schoolDomains lookup returned, or null. An INACTIVE
 * mapping is treated as no mapping: `active: false` is how an address is
 * retired without deleting the row that records it ever existed.
 *
 * The unmapped verdict is deliberately conservative. A deployment that has
 * configured neither a zone nor its own platform hosts cannot tell a tenant
 * address from its own, so it says "platform" and behaves as it always has. The
 * failure mode of guessing wrong in the other direction is the shared domain
 * showing every visitor a not-set-up page, which is the entire product down.
 */
export function resolveHostMode(
  hostname: unknown,
  mapping: SchoolDomainMapping | null,
  config: PlatformConfig = {}
): HostVerdict {
  const { platformHosts = [], zone = "" } = config;
  const host = normaliseHostname(hostname);

  /**
   * OUR OWN ADDRESSES BEAT ANY MAPPING, and this ordering is a deliberate
   * hardening over the ResultPeak original, which checks the mapping first.
   *
   * ResultPeak's write path refuses to create a document on a platform host or
   * a reserved label, so over there the case cannot arise. It can still arise
   * HERE: a document written by hand in the Firebase console, or by a
   * ResultPeak build that predates its own check, would otherwise let somebody
   * brand the shared domain - or the zone apex, which is what `www.{zone}`
   * normalises to - as one school's. That is the whole product wearing one
   * tenant's colours. Refusing costs nothing, because a platform host is never
   * looked up in the first place (`shouldLookUpHost`), so this only ever fires
   * on a mapping somebody went out of their way to create.
   */
  const ours = isPlatformHost(host, { platformHosts, zone }) || isReservedHost(host, config);

  if (!ours && mapping && mapping.active !== false && str(mapping.schoolId)) {
    return { mode: "school", hostname: host, schoolId: str(mapping.schoolId) };
  }

  if (isPlatformHost(host, { platformHosts, zone })) {
    return { mode: "platform", hostname: host, schoolId: "" };
  }

  const configured =
    Boolean(normaliseHostname(zone)) ||
    platformHosts.map((entry) => normaliseHostname(entry)).some(Boolean);
  if (!configured) {
    return { mode: "platform", hostname: host, schoolId: "" };
  }

  return { mode: "unmapped", hostname: host, schoolId: "" };
}

/**
 * Whether a hostname is worth a Firestore read at all.
 *
 * A platform host never has a mapping, so looking one up spends a read on every
 * visitor to the shared domain, every dev server reload and every preview
 * deployment. On a Spark plan shared with a live school's exam day that is not
 * a micro-optimisation, it is the difference between this feature costing
 * nothing and costing the daily quota.
 *
 * A reserved host is refused here too, so a hand-written document at
 * `admin.{zone}` is never even fetched.
 */
export function shouldLookUpHost(hostname: unknown, config: PlatformConfig = {}): boolean {
  const host = normaliseHostname(hostname);
  if (!host) return false;
  if (isReservedHost(host, config)) return false;
  return !isPlatformHost(host, config);
}

/**
 * The platform hosts named by configuration, as a list.
 *
 * Accepts a comma-separated string of hostnames or origins, so the value can be
 * pasted from wherever the operator already keeps it.
 */
export function parsePlatformHosts(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => normaliseHostname(entry))
    .filter(Boolean);
}

/** Read this deployment's own addresses out of the environment. */
export function platformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  return {
    zone: normaliseHostname(env.SCHOOL_DOMAIN_ZONE ?? ""),
    platformHosts: parsePlatformHosts(env.PLATFORM_HOSTS ?? ""),
  };
}

/**
 * The address to PRINT for a school, out of everything it holds.
 *
 * A school normally answers at several addresses at once: the free subdomain it
 * was given and the domain it later bought both resolve, both stay active, and
 * neither is more real than the other. `isPrimary` settles one question only,
 * which is which address goes on a class sign-in sheet a tutor prints.
 *
 * The primary if there is a live one, else the alphabetically first live
 * address so the choice is deterministic, else "". A caller that gets "" prints
 * what it printed before this feature existed - the shared domain and the
 * school's /s/{slug} - which is always correct and never blank.
 *
 * SCOPED TO ONE PRODUCT, and every caller in this repo passes THIS_PRODUCT. A
 * school using both apps holds a results address and a lessons address in one
 * collection, each primary for its own app. Without the filter the alphabetical
 * tie-break hands both apps whichever sorts first, which is how a tutor's
 * sign-in card for lessons ends up naming the exam portal.
 */
export function printableAddress(
  domains: { hostname: string; active?: boolean; isPrimary?: boolean; product?: unknown }[] = [],
  product: SchoolDomainProduct = DEFAULT_DOMAIN_PRODUCT
): string {
  const wanted = normaliseProduct(product);
  const live = domains
    .filter((row) => row?.active !== false && normaliseHostname(row?.hostname))
    .filter((row) => normaliseProduct(row?.product) === wanted)
    .map((row) => ({
      hostname: normaliseHostname(row.hostname),
      isPrimary: row.isPrimary === true,
    }));

  const primary = live.find((row) => row.isPrimary);
  if (primary) return primary.hostname;
  return live.map((row) => row.hostname).sort()[0] ?? "";
}
