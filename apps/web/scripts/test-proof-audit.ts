/**
 * test-proof-audit.ts — does the proof-of-delivery audit still detect a loss?
 *
 * The audit's whole job is to notice when a signature or a shelf photo has
 * gone missing or been replaced. A check like that fails silently when the
 * CHECK breaks: it goes green, nobody looks, and the thing it was watching
 * rots. So every answer it can give is asserted here, against a real Postgres
 * and an injected object reader.
 *
 * THE FIRST VERSION OF THIS FILE WAS WRONG AND PASSED ANYWAY.
 *
 * It walked the bucket through a fake Storage API and hashed a sample big
 * enough to cover every object. Deleting the entire existence branch from the
 * audit still went green -- the missing file simply 404'd on download and got
 * reported that way instead. Two mechanisms, one of them untested, and the
 * untested one is the only one that runs at scale: the sample is 25 objects
 * out of thousands. Found by breaking the audit on purpose and watching the
 * suite stay green. Every case below therefore names which mechanism it is
 * exercising, and the existence check is tested with the contents check
 * switched off.
 *
 * Existence is a SQL join rather than API calls, so the fixture inserts and
 * deletes rows in storage.objects -- which is a fair imitation of a lost
 * object, because that table IS Supabase's record of what the bucket holds.
 * The audit reads it through jb_proof_objects(), the security-definer function
 * migration 094 added after the first live run came back "permission denied
 * for schema storage"; the fixture writes the table directly, so this exercises
 * the real path from both ends.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/test-proof-audit.ts
 *
 * Writes to delivery_photos and storage.objects. Point it at the CI database
 * or a throwaway; it refuses anything that looks like Supabase.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { auditProof, proofAuditFailed, proofAuditLines, proofAuditNotes, PROOF_BUCKET, type ObjectReader } from "../lib/proof-audit";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("CANNOT RUN  set DATABASE_URL to a throwaway database."); process.exit(2); }
if (/supabase\.(co|com)|pooler\.supabase/.test(DB)) {
  console.error("REFUSING: DATABASE_URL points at Supabase. This test writes to delivery_photos and storage.objects.");
  process.exit(2);
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

const A_PHOTO = "2026-09-09/store-a/photo-11111111-1111-1111-1111-111111111111.jpg";
const A_SIG   = "2026-09-09/store-a/signature-22222222-2222-2222-2222-222222222222.jpg";
const B_PHOTO = "2026-09-09/store-b/photo-33333333-3333-3333-3333-333333333333.jpg";
const BYTES: Record<string, string> = { [A_PHOTO]: "PHOTO-A", [A_SIG]: "SIG-A", [B_PHOTO]: "PHOTO-B" };

let pass = 0;
const fails: string[] = [];
const is = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};
const has = (label: string, hay: string, needle: string) => {
  if (hay.includes(needle)) { pass++; return; }
  fails.push(`${label}\n      output did not contain: ${needle}`);
};

const sql = postgres(DB, { max: 2, prepare: false });
type SqlArg = Parameters<typeof auditProof>[0]["sql"];

/** Reads from an in-memory bucket. Swapping one entry is how a tampered file
 *  is simulated; the audit never sees a network. */
function reader(bytes: Record<string, string>): ObjectReader {
  return async (path) => {
    const v = bytes[path];
    return v == null ? { error: "not found" } : Buffer.from(v);
  };
}

async function seed() {
  await sql`insert into regions (id, name) values ('b0000000-0000-0000-0000-0000000000f1','PoD Region') on conflict do nothing`;
  await sql`insert into runs (id, name, region_id) values ('c0000000-0000-0000-0000-0000000000f1','PoD Run','b0000000-0000-0000-0000-0000000000f1') on conflict do nothing`;
  await sql`
    insert into stores (id, name, retailer, region_id, default_run_id, active) values
     ('d0000000-0000-0000-0000-0000000000f1','PoD Store A','coles','b0000000-0000-0000-0000-0000000000f1','c0000000-0000-0000-0000-0000000000f1',true),
     ('d0000000-0000-0000-0000-0000000000f2','PoD Store B','coles','b0000000-0000-0000-0000-0000000000f1','c0000000-0000-0000-0000-0000000000f1',true)
    on conflict (id) do nothing`;
  await sql`
    insert into deliveries (id, store_id, delivery_date, status, driver_sig_name) values
     ('f0000000-0000-0000-0000-0000000000f1','d0000000-0000-0000-0000-0000000000f1','2026-09-09','delivered','Ahmed K'),
     ('f0000000-0000-0000-0000-0000000000f2','d0000000-0000-0000-0000-0000000000f2','2026-09-09','delivered','Ahmed K')
    on conflict (store_id, delivery_date) do update set driver_sig_name = excluded.driver_sig_name`;

  await sql`delete from delivery_photos`;
  await sql`delete from storage.objects where bucket_id = ${PROOF_BUCKET}`;

  for (const [path, kind, did] of [
    [A_PHOTO, "photo", "f0000000-0000-0000-0000-0000000000f1"],
    [A_SIG, "signature", "f0000000-0000-0000-0000-0000000000f1"],
    [B_PHOTO, "photo", "f0000000-0000-0000-0000-0000000000f2"],
  ] as const) {
    await sql`
      insert into delivery_photos (delivery_id, storage_path, sha256, kind, gps_lat, gps_lng, gps_accuracy_m)
      values (${did}::uuid, ${path}, ${sha(BYTES[path])}, ${kind}, -33.89, 151.27, 8)`;
  }
}

/** What Supabase's own record of the bucket holds. */
async function bucketHolds(paths: string[]) {
  await sql`delete from storage.objects where bucket_id = ${PROOF_BUCKET}`;
  for (const p of paths) {
    await sql`
      insert into storage.objects (bucket_id, name, metadata)
      values (${PROOF_BUCKET}, ${p}, ${sql.json({ size: Buffer.byteLength(BYTES[p] ?? "") })})`;
  }
}

async function main() {
  await seed();

  // --- everything present and unchanged -----------------------------------
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 10 });
    is("all present: nothing missing", a.counts.missing, 0);
    is("all present: nothing changed", a.counts.checksums_mismatched, 0);
    is("all present: all three verified", a.counts.checksums_verified, 3);
    is("all present: no orphans", a.counts.orphans, 0);
    is("all present: does not fail", proofAuditFailed(a), false);
    is("all present: no findings", proofAuditLines(a), []);
  }

  // --- EXISTENCE, with the contents check switched off ---------------------
  // The case the first version of this file did not have. With sample 0 the
  // SQL join is the only thing that can catch a loss, so deleting that branch
  // turns these red instead of being masked by a 404 on download.
  {
    await bucketHolds([A_PHOTO, B_PHOTO]);
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 0 });
    is("a deleted signature, no contents check: counted missing", a.counts.missing, 1);
    is("a deleted signature, no contents check: nothing was hashed", a.counts.checksums_verified, 0);
    is("a deleted signature, no contents check: fails", proofAuditFailed(a), true);
    const lines = proofAuditLines(a).join("\n");
    has("a deleted signature, no contents check: names the file", lines, A_SIG);
    has("a deleted signature, no contents check: says MISSING", lines, "MISSING");
    // The store and the date, not only the path -- a path alone does not tell
    // anyone which drop is now unevidenced.
    has("a deleted signature, no contents check: names the store", lines, "PoD Store A");
    has("a deleted signature, no contents check: names the date", lines, "2026-09-09");
  }

  // --- CONTENTS: the file is listed but is not the file we recorded --------
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    const swapped = { ...BYTES, [A_SIG]: "SOMEONE-ELSES-SIGNATURE" };
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(swapped), sample: 10 });
    is("a swapped signature: one mismatch", a.counts.checksums_mismatched, 1);
    // Nothing is MISSING here, and keeping the two apart matters: "the file is
    // gone" and "the file is not the one we recorded" are different problems.
    is("a swapped signature: nothing is missing", a.counts.missing, 0);
    is("a swapped signature: fails", proofAuditFailed(a), true);
    const lines = proofAuditLines(a).join("\n");
    has("a swapped signature: says CHANGED", lines, "CHANGED");
    has("a swapped signature: prints the recorded checksum", lines, sha("SIG-A"));
    has("a swapped signature: prints what it found", lines, sha("SOMEONE-ELSES-SIGNATURE"));
  }

  // --- CONTENTS is bounded, and that trade is asserted --------------------
  // With the sample at zero a swapped file is NOT caught. That is the
  // documented cost of not hashing gigabytes weekly, so it is written down as
  // a test rather than left to be discovered by someone trusting a green tick.
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    const swapped = { ...BYTES, [A_SIG]: "SOMEONE-ELSES-SIGNATURE" };
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(swapped), sample: 0 });
    is("sample 0: a swap is not caught, by design", a.counts.checksums_mismatched, 0);
    is("sample 0: and the audit passes", proofAuditFailed(a), false);
  }

  // --- listed, but unreadable ---------------------------------------------
  // storage.objects says it is there and the download fails. That is a missing
  // object with a different cause, not a third category.
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    const gone = { ...BYTES };
    delete gone[A_SIG];
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(gone), sample: 10 });
    is("listed but unreadable: counted missing", a.counts.missing, 1);
    is("listed but unreadable: not counted as verified", a.counts.checksums_verified, 2);
    is("listed but unreadable: fails", proofAuditFailed(a), true);
  }

  // --- bytes with no row behind them --------------------------------------
  // Something wrote to the bucket outside the app, or a row was deleted from
  // under an object. Reported, but it does NOT fail the audit: untidy is not
  // the same as lost evidence.
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO, "2026-09-09/store-a/stray.jpg"]);
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 10 });
    is("an orphan: counted", a.counts.orphans, 1);
    is("an orphan: nothing missing", a.counts.missing, 0);
    is("an orphan: does not fail the audit", proofAuditFailed(a), false);
    has("an orphan: is reported", proofAuditLines(a).join("\n"), "ORPHAN");
  }

  // --- BLIND: the audit cannot see the rows it is auditing -----------------
  // The failure this nearly shipped with. delivery_photos has RLS, enabled and
  // forced; a scheduled call has no session, so every policy is false and the
  // table returns no rows rather than an error. Left unchecked the audit reads
  // 0 recorded / 0 missing / 0 changed and reports a green tick over a table it
  // cannot see -- worse than the "permission denied for schema storage" it
  // began with, and the same bug it exists to catch.
  //
  // Simulated by running the audit as jbo_app inside a transaction with no
  // claims set, which is exactly what a cron looks like to the database.
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    await sql.begin(async (tx) => {
      await tx`set local role jbo_app`;
      const a = await auditProof({ sql: tx as unknown as SqlArg, read: reader(BYTES), sample: 10 });
      is("blind: sees no rows", a.counts.recorded, 0);
      is("blind: but knows three are there", a.counts.actually_there, 3);
      is("blind: says so", a.blind, { visible: 0, actually_there: 3 });
      // The whole point. Nothing missing, nothing changed, and it must STILL
      // not pass.
      is("blind: nothing looks missing", a.counts.missing, 0);
      is("blind: nothing looks changed", a.counts.checksums_mismatched, 0);
      is("blind: and it FAILS anyway", proofAuditFailed(a), true);
      has("blind: names the gap", proofAuditLines(a).join("\n"), "could see 0 of 3");
      await tx`set local role none`;
    });
  }

  // --- and NOT blind when it can see everything ---------------------------
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 0 });
    is("not blind: sees all three", a.counts.recorded, 3);
    is("not blind: blind is null", a.blind, null);
    is("not blind: passes", proofAuditFailed(a), false);
  }

  // --- it says HOW it read, not only what it found -------------------------
  // Run #2 on production came back recorded:4, blind:null -- a clean result
  // that is equally consistent with "the identity worked" and "this role is
  // never subject to a policy in the first place". The second would mean RLS
  // is not protecting the live app at all and every policy written this week
  // is untested against the real connection. Same number either way, so the
  // audit reports which one it is rather than leaving it to be wondered about.
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    const a = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 0, withIdentity: false });
    is("read_as: names the database user", typeof a.read_as.db_user === "string" && a.read_as.db_user.length > 0, true);
    is("read_as: reports no identity when none was given", a.read_as.with_identity, false);
    const b = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 0, withIdentity: true });
    is("read_as: reports an identity when one was", b.read_as.with_identity, true);
    // This test runs as the migration owner, which does bypass RLS -- so the
    // note must be there. If it ever is not, the flag is not being read.
    is("read_as: a bypassing role is flagged", a.read_as.bypasses_rls, true);
    // In notes, NOT findings. A clean run must still report no findings.
    has("read_as: and says so in the notes", proofAuditNotes(a).join("\n"), "BYPASSES row-level security");
    is("read_as: the note is not a finding", proofAuditLines(a), []);
    // A note, not a failure. The audit's job is the proofs, not the flip.
    is("read_as: bypassing does not fail the audit", proofAuditFailed(a), false);
  }

  // --- and a non-bypassing role is not flagged -----------------------------
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    await sql.begin(async (tx) => {
      await tx`set local role jbo_app`;
      const a = await auditProof({ sql: tx as unknown as SqlArg, read: reader(BYTES), sample: 0, withIdentity: false });
      is("read_as: jbo_app does not bypass RLS", a.read_as.bypasses_rls, false);
      is("read_as: and it is named", a.read_as.db_user, "jbo_app");
      has("read_as: the note asks for an identity instead", proofAuditNotes(a).join("\n"), "Set FEED_POLL_USER_ID");
      await tx`set local role none`;
    });
  }

  // --- the manifest is opt-in ---------------------------------------------
  // It carries signer names and GPS for every drop. Handing that back by
  // default is how it ends up somewhere it should not be.
  {
    await bucketHolds([A_PHOTO, A_SIG, B_PHOTO]);
    const off = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 0 });
    is("manifest: absent unless asked for", off.objects, undefined);
    const on = await auditProof({ sql: sql as unknown as SqlArg, read: reader(BYTES), sample: 0, includeObjects: true });
    is("manifest: three rows when asked for", on.objects?.length, 3);
    is("manifest: carries the signer", on.objects?.[0]?.signed_by, "Ahmed K");
    // Dates come back as text. Handed over as Date objects they render as
    // "Thu Sep 10 2026 00:00:00 GMT+0000 (Coordinated Universal Time)".
    is("manifest: the delivery date is a plain date", on.objects?.[0]?.delivery_date, "2026-09-09");
  }

  await sql`delete from delivery_photos`;
  await sql`delete from storage.objects where bucket_id = ${PROOF_BUCKET}`;
  await sql.end();

  if (fails.length) {
    console.error(`\n  ${fails.length} FAILED, ${pass} passed:\n`);
    for (const f of fails) console.error("    " + f + "\n");
    process.exit(1);
  }
  console.log(`\n  ${pass} cases pass.\n`);
}

main().catch(async (e) => {
  try { await sql.end(); } catch { /* already closed */ }
  console.error("CANNOT RUN  " + (e instanceof Error ? e.stack : String(e)));
  process.exit(2);
});
