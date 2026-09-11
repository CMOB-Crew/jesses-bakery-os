/* Signing a request to Cloudflare R2, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SIXTY LINES OF CRYPTO AND NOT A DEPENDENCY
 * ---------------------------------------------------------------------------
 * R2 speaks the S3 API and only the S3 API, so something has to produce an AWS
 * Signature Version 4. The obvious answer is @aws-sdk/client-s3. It is roughly
 * three megabytes in a Netlify function bundle to make one PUT per file, and
 * it drags a lockfile change through a repository where every other network
 * call is a bare fetch.
 *
 * The signature itself is a published, frozen specification with official test
 * vectors, and that is the part that matters here: hand-rolled request signing
 * fails SILENTLY and identically to a wrong password. You get 403, and no way
 * to tell "my signature is wrong" from "the key is wrong" from "the bucket is
 * wrong". So the test file asserts this implementation against AWS's own
 * worked example, byte for byte, and it runs with no credentials and no
 * network. If the signing is broken, CI says so before anyone is staring at a
 * 403 wondering which of three things it is.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * No listing, no deleting, no multipart. The sync only ever writes, always to
 * a key it computes from the source path, and re-writing an object with the
 * same bytes is free and idempotent. That is the whole reason the sync can
 * work on a date window instead of diffing two buckets: the expensive,
 * dangerous operations are the ones not implemented here.
 *
 * Nothing in this file logs, returns or throws a value that contains the
 * secret key. The signature is derived from it; the key itself never leaves.
 */

import { createHash, createHmac } from "node:crypto";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

/** null when the backup is not switched on for this site. Never throws: a
 *  missing bucket is a configuration state, not an error, and the caller says
 *  so in words rather than crashing a weekly job. */
export function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID ?? "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "";
  const bucket = process.env.R2_BUCKET ?? "";
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

/** Which of the four is missing, for an error message a person can act on.
 *  Names only -- never values. */
export function r2Missing(): string[] {
  return ([
    ["R2_ACCOUNT_ID", process.env.R2_ACCOUNT_ID],
    ["R2_ACCESS_KEY_ID", process.env.R2_ACCESS_KEY_ID],
    ["R2_SECRET_ACCESS_KEY", process.env.R2_SECRET_ACCESS_KEY],
    ["R2_BUCKET", process.env.R2_BUCKET],
  ] as const).filter(([, v]) => !v).map(([k]) => k);
}

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** The four-step key derivation, exported only so the test can assert it
 *  against AWS's own published worked example. That example is the one part of
 *  SigV4 with a documented expected output, and it is the part where a silent
 *  mistake is indistinguishable from a wrong password. */
export function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), service), "aws4_request");
}

/** RFC 3986 for a path segment. S3 canonicalisation encodes everything except
 *  the unreserved set, and notably does NOT leave "+" or "*" alone the way
 *  encodeURIComponent does. A signature over a wrongly-escaped path is a 403
 *  that looks exactly like a bad key, which is why this is its own function
 *  with its own test. */
export function uriEscape(s: string): string {
  return Array.from(Buffer.from(s, "utf8"))
    .map((c) => {
      const ch = String.fromCharCode(c);
      if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
      return "%" + c.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

/** Each "/" separates segments and stays literal; everything else is escaped. */
export function canonicalPath(key: string): string {
  return "/" + key.split("/").map(uriEscape).join("/");
}

export type SignedRequest = { url: string; headers: Record<string, string> };

/**
 * Sign one PutObject. Exported with every input explicit -- including the
 * clock -- because a signature is only testable if the time it was made at is
 * an argument rather than Date.now().
 */
export function signPut(opts: {
  cfg: R2Config;
  key: string;
  body: Buffer;
  contentType: string;
  now: Date;
  /** Overridable only so the test can use AWS's own example host. */
  host?: string;
  region?: string;
}): SignedRequest {
  const { cfg, key, body, contentType, now } = opts;
  const host = opts.host ?? `${cfg.accountId}.r2.cloudflarestorage.com`;
  // R2 ignores the region but the signature does not: it must be "auto" and it
  // must match on both sides.
  const region = opts.region ?? "auto";
  const service = "s3";

  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const path = `/${cfg.bucket}${canonicalPath(key)}`;

  // Signed headers, lowercased and sorted. Content-type is included because
  // otherwise R2 stores every photograph as application/octet-stream and the
  // day somebody opens the backup they get a download instead of a picture.
  const headers: Record<string, string> = {
    host,
    "content-type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    "PUT", path, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest),
  ].join("\n");

  const kSigning = signingKey(cfg.secretAccessKey, dateStamp, region, service);
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    url: `https://${host}${path}`,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** The only network call in this module. Returns an error rather than throwing
 *  so one unreadable object cannot abandon a whole weekly run. */
export async function putObject(opts: {
  cfg: R2Config;
  key: string;
  body: Buffer;
  contentType: string;
  now?: Date;
}): Promise<{ ok: true } | { error: string }> {
  const signed = signPut({ ...opts, now: opts.now ?? new Date() });
  try {
    const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: new Uint8Array(opts.body) });
    if (res.ok) return { ok: true };
    // R2's error bodies are XML and do not echo credentials, but they are
    // truncated anyway: an error string ends up in a public Actions log.
    const text = (await res.text().catch(() => "")).slice(0, 200);
    return { error: `R2 answered ${res.status}. ${text || "No detail was given."}` };
  } catch (e) {
    return { error: `R2 could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Content type from the path, because the source bucket does not always carry
 *  one and a backup of a JPEG labelled octet-stream is a worse backup. */
export function contentTypeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}
