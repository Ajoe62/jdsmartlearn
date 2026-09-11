import "server-only";
import { Agent } from "node:https";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
    /**
     * Only checksum when an operation requires it. Since SDK 3.729 the default
     * adds a CRC32 checksum to PutObject and UploadPart, and a PRESIGNED address
     * then demands a checksum header the browser never sends, so every direct
     * upload fails its signature check. Cloudflare documents this setting for R2.
     */
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
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

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err.name === "NoSuchKey" ||
    err.name === "NotFound" ||
    err.$metadata?.httpStatusCode === 404
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
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function r2Delete(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Size and type of an object, or null when there is none. Reads no bytes. */
export async function r2Head(
  key: string
): Promise<{ size: number; contentType?: string } | null> {
  try {
    const res = await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Server-side copy inside the bucket. No bytes pass through this function, so a
 * 100 MB file claims as fast as a 1 KB one. The content type is REPLACED with
 * the server's own, never kept from whatever the browser sent.
 */
export async function r2Copy(fromKey: string, toKey: string, contentType: string): Promise<void> {
  const source = fromKey.split("/").map(encodeURIComponent).join("/");
  await getClient().send(
    new CopyObjectCommand({
      Bucket: bucket(),
      Key: toKey,
      CopySource: `${bucket()}/${source}`,
      ContentType: contentType,
      MetadataDirective: "REPLACE",
    })
  );
}

/** A time-limited address the browser can PUT one whole file to. */
export async function r2PresignPut(
  key: string,
  contentType: string,
  expiresIn: number
): Promise<string> {
  return getSignedUrl(
    getClient(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn }
  );
}

export async function r2CreateMultipart(key: string, contentType: string): Promise<string> {
  const res = await getClient().send(
    new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType })
  );
  if (!res.UploadId) throw new Error("R2 returned no upload id.");
  return res.UploadId;
}

/** A time-limited address the browser can PUT one part to. */
export async function r2PresignPart(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn: number
): Promise<string> {
  return getSignedUrl(
    getClient(),
    new UploadPartCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn }
  );
}

export async function r2CompleteMultipart(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<void> {
  await getClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    })
  );
}

export async function r2AbortMultipart(key: string, uploadId: string): Promise<void> {
  await getClient().send(
    new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId })
  );
}

/**
 * A time-limited address to download one object, with the type and disposition
 * fixed by the server so the browser opens it the way our own route would have.
 */
export async function r2PresignGet(
  key: string,
  opts: { expiresIn: number; contentType: string; disposition: string }
): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: opts.disposition,
    }),
    { expiresIn: opts.expiresIn }
  );
}
