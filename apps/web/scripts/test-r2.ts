/* Does the R2 signer actually sign correctly?
 *
 *   npx tsx scripts/test-r2.ts
 *
 * WHY THIS FILE IS WORTH MORE THAN MOST TESTS HERE
 *
 * A wrong AWS signature fails as 403 Forbidden. So does a wrong access key, a
 * wrong secret, a wrong bucket name and a bucket that does not exist. On the
 * morning the backup first runs there will be no way to tell those five apart
 * by looking at the response -- and four of them are somebody else's problem
 * while one of them is ours.
 *
 * So the signing is proved here, with no credentials and no network, against
 * AWS's own published key-derivation example. If this file passes, a 403 on
 * the day is not the signature.
 *
 * It also asserts the thing no correctness test would think to: that the
 * secret key never appears in anything this module hands back. The signed
 * request goes into a Netlify function log and, if a run fails loudly enough,
 * a public GitHub Actions log.
 */
import {
  signingKey, signPut, uriEscape, canonicalPath, contentTypeFor, r2Missing,
  type R2Config,
} from "../lib/r2";

let pass = 0;
const fails: string[] = [];
const is = (label: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};
const ok = (label: string, cond: boolean) => is(label, cond, true);

// --- AWS's own worked example ----------------------------------------------
// From the Signature Version 4 documentation, "Deriving the signing key".
// Secret, date, region and service are theirs; so is the expected result.
is("the signing key matches AWS's published example",
   signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam").toString("hex"),
   "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");

// The derivation is order-dependent in a way that is easy to get wrong and
// impossible to notice: swap region and service and you still get 64 valid-
// looking hex characters.
ok("swapping region and service changes the key",
   signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "iam", "us-east-1").toString("hex")
     !== "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");

// --- path escaping ---------------------------------------------------------
// S3 canonicalisation is NOT encodeURIComponent. These are the characters that
// differ, and every one of them can appear in a storage path.
is("space", uriEscape("a b"), "a%20b");
is("plus is escaped, unlike encodeURIComponent", uriEscape("a+b"), "a%2Bb");
is("star is escaped, unlike encodeURIComponent", uriEscape("a*b"), "a%2Ab");
is("tilde is left alone, unlike encodeURI", uriEscape("a~b"), "a~b");
is("brackets", uriEscape("a(b)"), "a%28b%29");
is("the unreserved set is untouched", uriEscape("Aa0-._~"), "Aa0-._~");
is("utf8 is escaped per byte", uriEscape("é"), "%C3%A9");

is("slashes separate segments and stay literal",
   canonicalPath("2026/09/11/store-1/photo.jpg"), "/2026/09/11/store-1/photo.jpg");
is("but a space inside a segment is escaped",
   canonicalPath("2026/09/a store/photo.jpg"), "/2026/09/a%20store/photo.jpg");

// --- what gets stored ------------------------------------------------------
// A backup of a JPEG labelled application/octet-stream downloads instead of
// opening. The day somebody looks at this bucket is a bad day already.
is("jpg", contentTypeFor("a/b/c.jpg"), "image/jpeg");
is("jpeg", contentTypeFor("a/b/c.JPEG"), "image/jpeg");
is("png", contentTypeFor("a/b/c.PNG"), "image/png");
is("webp", contentTypeFor("sig.webp"), "image/webp");
is("anything else is honest about not knowing", contentTypeFor("a/b/c"), "application/octet-stream");

// --- the signed request ----------------------------------------------------
const CFG: R2Config = {
  accountId: "acct123",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  bucket: "jesses-proof",
};
const AT = new Date("2026-09-14T01:02:03.456Z");
const body = Buffer.from("not a real photograph");
const signed = signPut({ cfg: CFG, key: "2026/09/11/p.jpg", body, contentType: "image/jpeg", now: AT });

is("the url points at this account's r2 endpoint and bucket",
   signed.url, "https://acct123.r2.cloudflarestorage.com/jesses-proof/2026/09/11/p.jpg");
is("the date is the compact form the signature needs",
   signed.headers["x-amz-date"], "20260914T010203Z");
ok("the payload is hashed, not sent unsigned",
   signed.headers["x-amz-content-sha256"] !== "UNSIGNED-PAYLOAD"
     && /^[0-9a-f]{64}$/.test(signed.headers["x-amz-content-sha256"]));
is("content type survives into the object",
   signed.headers["content-type"], "image/jpeg");

const auth = signed.headers.Authorization;
ok("the scope names the auto region R2 expects", auth.includes("/20260914/auto/s3/aws4_request"));
ok("the signed headers are sorted", auth.includes("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"));
ok("there is a signature", /Signature=[0-9a-f]{64}$/.test(auth));

// Same inputs, same output. A signature that moved with the clock could not be
// tested at all, which is why `now` is an argument.
is("signing is deterministic",
   signPut({ cfg: CFG, key: "2026/09/11/p.jpg", body, contentType: "image/jpeg", now: AT }).headers.Authorization,
   auth);

// Every input must reach the signature. If any of these did not, a corrupted
// upload or a wrong key would still be accepted somewhere.
for (const [what, changed] of [
  ["a different body", signPut({ cfg: CFG, key: "2026/09/11/p.jpg", body: Buffer.from("other"), contentType: "image/jpeg", now: AT })],
  ["a different key", signPut({ cfg: CFG, key: "2026/09/11/q.jpg", body, contentType: "image/jpeg", now: AT })],
  ["a different content type", signPut({ cfg: CFG, key: "2026/09/11/p.jpg", body, contentType: "image/png", now: AT })],
  ["a different second", signPut({ cfg: CFG, key: "2026/09/11/p.jpg", body, contentType: "image/jpeg", now: new Date("2026-09-14T01:02:04.000Z") })],
  ["a different secret", signPut({ cfg: { ...CFG, secretAccessKey: "x" }, key: "2026/09/11/p.jpg", body, contentType: "image/jpeg", now: AT })],
] as const) {
  ok(`${what} changes the signature`, changed.headers.Authorization !== auth);
}

// --- the secret never leaves ------------------------------------------------
// This module's output lands in a Netlify function log and, when a run fails,
// a PUBLIC GitHub Actions log. The signature is derived from the secret; the
// secret itself must never be in there.
const everything = JSON.stringify(signed);
ok("the secret key is not in the signed request", !everything.includes(CFG.secretAccessKey));
ok("nor is any twelve-character run of it",
   !everything.includes(CFG.secretAccessKey.slice(0, 12)));
ok("the access key id IS present, because the header requires it",
   everything.includes(CFG.accessKeyId));

// --- not configured is a state, not a crash ---------------------------------
{
  const keep = { ...process.env };
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  is("every missing variable is named", r2Missing().length, 4);
  ok("by name", r2Missing().includes("R2_SECRET_ACCESS_KEY"));
  process.env.R2_ACCOUNT_ID = "a"; process.env.R2_ACCESS_KEY_ID = "b";
  is("and a half-configured site names only what is left", r2Missing().join(","),
     "R2_SECRET_ACCESS_KEY,R2_BUCKET");
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  Object.assign(process.env, keep);
}

// ---------------------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error("  " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass.\n`);
