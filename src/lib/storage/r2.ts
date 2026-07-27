import "server-only";
import { Agent } from "node:https";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

/**
 * Cloudflare R2 via its S3-compatible API. Free tier: 10 GB storage, zero
 * egress fees. This module is only imported by storage/provider.ts.
 */

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey || !process.env.R2_BUCKET) {
    throw new Error("Missing R2 credentials. Set R2_* variables in .env.local.");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 4,
    // TLS 1.3 uploads >~1 MB fail intermittently on some Windows/ISP setups
    // (EPROTO "bad record mac" - middlebox TLS interception corrupts long
    // streams). TLS 1.2 + a fresh connection per request is reliably clean;
    // verified against R2 with 4 MB payloads. Do not remove without re-testing
    // large uploads from a Nigerian ISP connection.
    requestHandler: new NodeHttpHandler({
      httpsAgent: new Agent({ keepAlive: false, maxVersion: "TLSv1.2" }),
    }),
  });
  return client;
}

const bucket = () => process.env.R2_BUCKET!;

export function r2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

export async function r2Put(key: string, body: Buffer, contentType: string): Promise<void> {
  await getClient().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType })
  );
}

export async function r2Get(
  key: string
): Promise<{ body: Buffer; contentType?: string } | null> {
  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key })
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return { body: Buffer.from(bytes), contentType: res.ContentType };
  } catch (e) {
    if ((e as { name?: string }).name === "NoSuchKey") return null;
    throw e;
  }
}

export async function r2Delete(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
