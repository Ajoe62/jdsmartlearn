/**
 * Read-only check of the R2 bucket settings that direct uploads depend on.
 *
 *   npm run check:r2
 *   npm run check:r2 -- https://your-production-domain   (also checks that origin)
 *
 * CHANGES NOTHING. It reads the bucket's CORS and lifecycle configuration and
 * reports. Setting them is a one-time step in the Cloudflare dashboard - see
 * docs/r2-bucket-setup.md. Without CORS, every browser upload fails; without the
 * lifecycle rule, uploads nobody claimed pile up forever.
 *
 * Talks to R2 directly rather than through src/lib/storage: those modules are
 * `server-only`, which does not resolve under tsx.
 */
import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Already in the environment, or run from a shell that set them.
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error("check:r2: R2_* variables are not set. Add them to .env.local.");
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const STAGING = "uploads/";

interface Finding {
  ok: boolean;
  line: string;
}

const findings: Finding[] = [];
const unreadable: string[] = [];

function errorName(e: unknown): string {
  return (e as { name?: string }).name ?? "";
}

function isDenied(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === "AccessDenied" || err.$metadata?.httpStatusCode === 403;
}

async function checkCors(): Promise<void> {
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: R2_BUCKET }));
    const rules = res.CORSRules ?? [];
    const methods = new Set(rules.flatMap((r) => (r.AllowedMethods ?? []).map((m) => m.toUpperCase())));
    for (const method of ["PUT", "GET", "HEAD"]) {
      findings.push({ ok: methods.has(method), line: `CORS allows ${method}` });
    }
    findings.push({
      ok: rules.some((r) => (r.AllowedHeaders ?? []).some((h) => h === "*" || h.toLowerCase() === "content-type")),
      line: "CORS allows the Content-Type request header",
    });
    findings.push({
      ok: rules.some((r) => (r.ExposeHeaders ?? []).some((h) => h.toLowerCase() === "etag")),
      line: "CORS exposes ETag (needed for files over 8 MB)",
    });
    const origins = [...new Set(rules.flatMap((r) => r.AllowedOrigins ?? []))];
    findings.push({
      ok: origins.length > 0,
      line: `CORS origins: ${origins.length > 0 ? origins.join(", ") : "none"}`,
    });
    for (const wanted of process.argv.slice(2)) {
      findings.push({
        ok: origins.includes("*") || origins.includes(wanted),
        line: `CORS allows the origin ${wanted}`,
      });
    }
  } catch (e) {
    if (isDenied(e)) {
      unreadable.push("CORS");
      return;
    }
    if (errorName(e) === "NoSuchCORSConfiguration") {
      findings.push({ ok: false, line: "CORS: no policy set - every browser upload will fail" });
      return;
    }
    throw e;
  }
}

async function checkLifecycle(): Promise<void> {
  try {
    const res = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: R2_BUCKET })
    );
    const rules = (res.Rules ?? []).filter((r) => (r.Status ?? "Enabled") === "Enabled");
    const prefixOf = (r: (typeof rules)[number]) => r.Filter?.Prefix ?? r.Prefix ?? "";

    findings.push({
      ok: rules.some((r) => prefixOf(r) === STAGING && (r.Expiration?.Days ?? 0) > 0),
      line: `Lifecycle deletes objects under ${STAGING}`,
    });
    findings.push({
      ok: rules.some(
        (r) =>
          (prefixOf(r) === STAGING || prefixOf(r) === "") &&
          (r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? 0) > 0
      ),
      line: "Lifecycle aborts unfinished multipart uploads",
    });
    // The dangerous mistake: an expiry rule with no prefix deletes EVERY file.
    findings.push({
      ok: !rules.some((r) => prefixOf(r) === "" && (r.Expiration?.Days ?? 0) > 0),
      line: "No lifecycle rule expires the whole bucket",
    });
  } catch (e) {
    if (isDenied(e)) {
      unreadable.push("lifecycle rules");
      return;
    }
    if (errorName(e) === "NoSuchLifecycleConfiguration") {
      findings.push({
        ok: false,
        line: `Lifecycle: no rules set - uploads nobody claimed under ${STAGING} are never cleared`,
      });
      return;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  await checkCors();
  await checkLifecycle();

  console.log(`\nR2 bucket ${R2_BUCKET}\n`);
  for (const f of findings) console.log(`  ${f.ok ? "ok  " : "FAIL"}  ${f.line}`);

  if (unreadable.length > 0) {
    console.log(
      `\n  This R2 token can't read the bucket's ${unreadable.join(" or ")}.` +
        `\n  Check them in the Cloudflare dashboard against docs/r2-bucket-setup.md.`
    );
  }

  const failed = findings.filter((f) => !f.ok);
  if (failed.length > 0) {
    console.error(`\ncheck:r2: FAILED - ${failed.length} setting(s) missing. See docs/r2-bucket-setup.md.`);
    process.exit(1);
  }
  console.log(
    unreadable.length > 0
      ? "\ncheck:r2: nothing wrong in what could be read."
      : "\ncheck:r2: OK - the bucket is ready for direct uploads."
  );
}

main().catch((e) => {
  console.error("check:r2: could not reach R2.", e);
  process.exit(1);
});
