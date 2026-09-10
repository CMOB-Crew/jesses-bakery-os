/* Does the proof of delivery still exist, and is it still the same file?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Supabase's own documentation is unambiguous: "Database backups do not include
 * objects you store via the Storage API." The shelf photo and the customer's
 * signature live in the `driver-proof` bucket. They are in no backup.
 *
 * That was written down on 3 September as "proof of delivery is in no backup",
 * and the sentence is not quite right, which matters because it changes what
 * has to be built. Splitting it properly:
 *
 *   IN the database, therefore in PITR
 *     delivery_photos.storage_path   where the file is
 *     delivery_photos.sha256         NOT NULL -- the exact bytes, provable
 *     delivery_photos.captured_at    when
 *     delivery_photos.gps_*          where, with an accuracy figure
 *     deliveries.driver_sig_name     who signed for it
 *
 *   NOT in any backup
 *     the image bytes themselves
 *
 * So if the bucket were lost tomorrow, Jesse would still hold a signed,
 * timestamped, geolocated record of every delivery, with a checksum for each
 * missing image. He loses the pictures, not the evidence that a drop happened.
 * Worth being precise about, because "we have no proof of delivery" and "we
 * have the record but not the photographs" are different conversations with a
 * retailer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * It does NOT copy the bucket anywhere. A full weekly dump is roughly 1,900
 * objects at 2-5MB once every store is live -- call it 6GB a week -- which is
 * not a GitHub runner's job, and the destination is a decision nobody has made
 * (Jesse's Azure was the suggestion). Building half of that against a guessed
 * destination would be worse than not building it.
 *
 * What it does is close the gap nothing else covers: TODAY, IF AN OBJECT
 * VANISHED FROM THE BUCKET, NOBODY WOULD EVER FIND OUT. The database would
 * still show a row with a checksum, the store page would still show a proof
 * badge, and the file behind it would be gone. Same shape as every other bug
 * found this week -- a record that is read as evidence of a thing nobody
 * checks.
 *
 * So, weekly:
 *
 *   1. EXISTENCE, for every row. One list call per day-prefix, not one request
 *      per object, and the size is compared too. Cheap enough to run over
 *      everything, every time.
 *
 *   2. CONTENTS, for a bounded sample. Re-downloading 6GB to re-hash it every
 *      week is the same bad idea as the full dump, so a rotating sample is
 *      hashed instead -- oldest first, so every object is eventually checked
 *      and no object is checked twice before all of them have been checked
 *      once.
 *
 *   3. THE MANIFEST. Every row's path, checksum, capture time, GPS and signer,
 *      written out as JSON. This is the small, useful half of a backup: it is
 *      a few hundred KB, it keeps for a year as a build artifact, and it is
 *      what a dispute actually needs. It is not a substitute for the images
 *      and does not pretend to be.
 *
 * Exit codes: 0 all present, 1 something is missing or has changed, 2 could not
 * run at all. Missing and changed are NOT warnings.
 *
 * Usage:
 *   DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/proof-of-delivery-audit.mjs [--sample N] [--out FILE]
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "driver-proof";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const SAMPLE = Math.max(0, Number(arg("--sample", "25")) || 0);
const OUT = arg("--out", null);

const die = (msg) => { console.error("CANNOT RUN  " + msg); process.exit(2); };

const dbUrl = process.env.DATABASE_URL;
const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
// Same three names as lib/supabase/admin.ts, and in the same order, so whatever
// the deployment calls it is what this reads. The first name that file ever
// used was not real -- it came out of a grep whose node_modules filter silently
// did nothing -- so the list is deliberate, not defensive coding.
const sbKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

if (!dbUrl) die("DATABASE_URL is not set.");
if (!sbUrl) die("SUPABASE_URL is not set.");
if (!sbKey) die("SUPABASE_SERVICE_ROLE_KEY is not set. Supabase dashboard -> Project Settings -> API.");

// postgres() parses the URL eagerly and throws synchronously on a bad one, so
// it is wrapped: an unreadable DATABASE_URL should say so on one line, not
// print a stack trace from inside a library.
let sql;
try {
  sql = postgres(dbUrl, {
    max: 2,
    ssl: /@(localhost|127\.0\.0\.1)/.test(dbUrl) ? undefined : "require",
    prepare: false,
  });
} catch (e) {
  die(`DATABASE_URL could not be parsed: ${e instanceof Error ? e.message : String(e)}`);
}
const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false, autoRefreshToken: false } });

const nf = (n) => n.toLocaleString("en-AU");

async function main() {
  // The signer comes from deliveries, not delivery_photos -- who signed is a
  // property of the drop, and the photo and the signature share it.
  const rows = await sql`
    select p.id::text            as id,
           p.storage_path        as path,
           p.kind                as kind,
           p.sha256              as sha256,
           p.captured_at         as captured_at,
           p.gps_lat             as lat,
           p.gps_lng             as lng,
           p.gps_accuracy_m      as accuracy_m,
           d.store_id::text      as store_id,
           s.name                as store_name,
           -- as text, not a Date. Rendered raw it reads "Thu Sep 10 2026
           -- 00:00:00 GMT+0000 (Coordinated Universal Time)" in the failure
           -- output and lands in the manifest with a timezone it never had.
           to_char(d.delivery_date, 'YYYY-MM-DD') as delivery_date,
           d.driver_sig_name     as signed_by
      from delivery_photos p
      join deliveries d on d.id = p.delivery_id
      left join stores s on s.id = d.store_id
     order by d.delivery_date, s.name, p.kind`;

  console.log(`\n  ${nf(rows.length)} proof object${rows.length === 1 ? "" : "s"} recorded in the database.`);

  if (!rows.length) {
    // Not a failure. Before go-live this is the correct answer, and a check
    // that goes red for being run early is one people learn to ignore.
    console.log("  Nothing to audit yet -- no driver has recorded a delivery.\n");
    if (OUT) writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), bucket: BUCKET, objects: [] }, null, 2));
    await sql.end();
    process.exit(0);
  }

  // ---- 1. existence, for everything -------------------------------------
  // storage_path is `<day>/<store>/<kind>-<uuid>.jpg`, so one list per
  // day/store folder covers every object under it. Grouping first means a
  // network round trip per folder rather than per file.
  const folders = new Map();
  for (const r of rows) {
    const cut = r.path.lastIndexOf("/");
    const dir = cut === -1 ? "" : r.path.slice(0, cut);
    if (!folders.has(dir)) folders.set(dir, new Map());
  }

  for (const dir of folders.keys()) {
    // list() pages at 100 by default and silently truncates past it, which
    // would read as "these objects are missing".
    let offset = 0;
    for (;;) {
      const { data, error } = await sb.storage.from(BUCKET).list(dir, { limit: 100, offset });
      if (error) die(`could not list ${BUCKET}/${dir}: ${error.message}`);
      for (const o of data) folders.get(dir).set(o.name, o);
      if (data.length < 100) break;
      offset += data.length;
    }
  }

  const missing = [];
  const present = [];
  for (const r of rows) {
    const cut = r.path.lastIndexOf("/");
    const dir = cut === -1 ? "" : r.path.slice(0, cut);
    const base = cut === -1 ? r.path : r.path.slice(cut + 1);
    const o = folders.get(dir)?.get(base);
    if (!o) missing.push(r);
    else present.push({ ...r, size: o.metadata?.size ?? null });
  }

  console.log(`  ${nf(present.length)} present in the bucket, ${nf(missing.length)} missing.`);

  // ---- 2. contents, for a sample ----------------------------------------
  // Oldest first. Over enough weeks every object gets hashed once before any
  // object gets hashed twice.
  const changed = [];
  const checked = [];
  for (const r of present.slice(0, SAMPLE)) {
    const { data, error } = await sb.storage.from(BUCKET).download(r.path);
    if (error) { missing.push({ ...r, note: `download failed: ${error.message}` }); continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    const got = createHash("sha256").update(buf).digest("hex");
    checked.push(r.path);
    if (got.toLowerCase() !== String(r.sha256).toLowerCase()) {
      changed.push({ ...r, got });
    }
  }
  if (SAMPLE > 0) {
    console.log(`  ${nf(checked.length)} checksum${checked.length === 1 ? "" : "s"} verified, ${nf(changed.length)} mismatched.`);
  }

  // ---- 3. the manifest ---------------------------------------------------
  const manifest = {
    generated_at: new Date().toISOString(),
    bucket: BUCKET,
    // Said plainly inside the file, because a manifest is exactly the sort of
    // thing someone finds in a year and mistakes for the backup.
    note: "This is the RECORD of each proof of delivery, not the image itself. The image bytes live in Supabase Storage and are in no backup. sha256 identifies the exact file each row refers to.",
    counts: { recorded: rows.length, present: present.length, missing: missing.length, checksums_verified: checked.length, checksums_mismatched: changed.length },
    objects: rows.map((r) => ({
      id: r.id,
      path: r.path,
      kind: r.kind,
      sha256: r.sha256,
      captured_at: r.captured_at,
      gps: r.lat == null || r.lng == null ? null : { lat: r.lat, lng: r.lng, accuracy_m: r.accuracy_m },
      store_id: r.store_id,
      store: r.store_name,
      delivery_date: r.delivery_date,
      signed_by: r.signed_by,
    })),
  };
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(manifest, null, 2));
    console.log(`  Manifest written to ${OUT}.`);
  }

  // ---- report ------------------------------------------------------------
  if (missing.length || changed.length) {
    console.error("\n  PROOF OF DELIVERY HAS CHANGED OR GONE MISSING.\n");
    for (const r of missing.slice(0, 20)) {
      console.error(`    MISSING  ${r.delivery_date} ${r.store_name ?? r.store_id} ${r.kind}`);
      console.error(`             ${r.path}${r.note ? "  (" + r.note + ")" : ""}`);
    }
    if (missing.length > 20) console.error(`    ... and ${nf(missing.length - 20)} more missing.`);
    for (const r of changed) {
      console.error(`    CHANGED  ${r.delivery_date} ${r.store_name ?? r.store_id} ${r.kind}`);
      console.error(`             ${r.path}`);
      console.error(`             recorded ${r.sha256}`);
      console.error(`             found    ${r.got}`);
    }
    console.error("\n  A signature or shelf photo is evidence. Neither should ever change,");
    console.error("  and nothing in the app updates one in place -- a retake replaces the");
    console.error("  row and its checksum together. Treat this as a real finding.\n");
    await sql.end();
    process.exit(1);
  }

  console.log("\n  Every recorded proof of delivery is present and unchanged.\n");
  await sql.end();
  process.exit(0);
}

main().catch(async (e) => {
  try { await sql.end(); } catch { /* already closed */ }
  die(e instanceof Error ? e.message : String(e));
});
