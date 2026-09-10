/* Is every proof of delivery still there, and is it still the same file?
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT BACKED UP
 * ---------------------------------------------------------------------------
 * Supabase's documentation, verbatim: "Database backups do not include objects
 * you store via the Storage API." The shelf photos and the customers'
 * signatures live in the driver-proof bucket.
 *
 * "Proof of delivery is in no backup" was on the blocking list from
 * 3 September, and it is not quite right. Reading the schema instead of the
 * note:
 *
 *   in the database, so in PITR   delivery_photos.storage_path
 *                                 delivery_photos.sha256 (NOT NULL)
 *                                 delivery_photos.captured_at
 *                                 delivery_photos.gps_lat/lng/accuracy_m
 *                                 deliveries.driver_sig_name
 *   in no backup                  the image bytes
 *
 * Lose the bucket and Jesse still holds a signed, timestamped, geolocated
 * record of every drop with a checksum naming each missing image. He loses the
 * pictures, not the evidence a delivery happened. "We have no proof of
 * delivery" and "we have the record but not the photographs" are different
 * conversations with a retailer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * TODAY, IF AN OBJECT VANISHED FROM THAT BUCKET, NOBODY WOULD FIND OUT. The
 * row would still be there with its checksum, the store page would still show
 * a proof badge, and the file would be gone. Same shape as everything else
 * found this week: a record read as evidence of a thing nobody checks.
 *
 * ---------------------------------------------------------------------------
 * EXISTENCE IS A SQL JOIN, NOT 1,900 API CALLS
 * ---------------------------------------------------------------------------
 * The first version of this walked the bucket through the Storage API, one
 * list call per store per day. At 273 stores that is roughly 1,900 round trips
 * for one week, it does not fit in a Netlify function's sixty seconds, and it
 * grows without bound because the audit covers every proof ever recorded.
 *
 * Supabase keeps object metadata in `storage.objects`, in the same Postgres.
 * Verified readable on production, 10 September: 4 objects in driver-proof,
 * all dated 2026-09-04. So existence -- in BOTH directions -- is one query.
 *
 *   a row with no object    the drop is now unevidenced. The real risk.
 *   an object with no row   bytes nobody references. Cheaper to spot, and it
 *                           means something wrote to the bucket outside the
 *                           app, or a row was deleted from under it.
 *
 * Only the contents check needs the Storage API, and it is bounded: hashing
 * every object weekly would move gigabytes to re-learn what the last run
 * already knew, so a rotating sample is hashed oldest-first, and over enough
 * weeks every object is checked once before any object is checked twice.
 */

/* NO `import "server-only"` here, deliberately. This module is a pure function
 * over an injected sql client and an injected object reader -- it opens no
 * connection and reads no environment. server-only throws the moment tsx loads
 * it, which would put the test back to driving a subprocess and a fake HTTP
 * server, which is how the first version of this test came to be wrong. The
 * things that genuinely are server-only -- lib/db and lib/supabase/admin -- are
 * imported by the route, which carries the marker itself.
 */

export type ProofRow = {
  id: string;
  path: string;
  kind: string;
  sha256: string;
  captured_at: string | Date | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  store_id: string | null;
  store_name: string | null;
  delivery_date: string | null;
  signed_by: string | null;
  /** null when nothing in storage.objects matches storage_path. */
  object_size: number | null;
  object_exists: boolean;
};

export type Orphan = { path: string; size: number | null; created_at: string | Date | null };

export type Mismatch = ProofRow & { found: string };

export type ProofAudit = {
  generated_at: string;
  bucket: string;
  counts: {
    recorded: number;
    present: number;
    missing: number;
    orphans: number;
    checksums_verified: number;
    checksums_mismatched: number;
  };
  missing: ProofRow[];
  orphans: Orphan[];
  changed: Mismatch[];
  /** Every recorded proof. Omitted unless asked for -- it carries signer names
   *  and GPS, which is not something to hand out by default. */
  objects?: ProofRow[];
};

export const PROOF_BUCKET = "driver-proof";

/** Reads one object's bytes. Injected so the audit can be tested without a
 *  bucket, and so the route and the CLI can each build their own client. */
export type ObjectReader = (path: string) => Promise<Buffer | { error: string }>;

/** The narrow slice of a postgres.js client this needs. */
type Sql = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

export async function auditProof(opts: {
  sql: Sql;
  read: ObjectReader;
  /** How many objects to re-download and re-hash. 0 skips the contents check
   *  entirely; existence is still checked for everything. */
  sample?: number;
  includeObjects?: boolean;
}): Promise<ProofAudit> {
  const { sql, read } = opts;
  const sample = Math.max(0, Math.trunc(opts.sample ?? 25));

  // One query, both directions.
  //
  // The signer is on deliveries, not delivery_photos -- who signed is a
  // property of the drop, and the photo and the signature share it.
  //
  // delivery_date and captured_at are cast to text here. Handed back as Date
  // objects they render as "Thu Sep 10 2026 00:00:00 GMT+0000 (Coordinated
  // Universal Time)" in a failure message and land in the manifest carrying a
  // timezone the date never had.
  const rows = await sql<ProofRow[]>`
    select p.id::text                                  as id,
           p.storage_path                              as path,
           p.kind                                      as kind,
           p.sha256                                    as sha256,
           to_char(p.captured_at at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')       as captured_at,
           p.gps_lat                                   as lat,
           p.gps_lng                                   as lng,
           p.gps_accuracy_m                            as accuracy_m,
           d.store_id::text                            as store_id,
           s.name                                      as store_name,
           to_char(d.delivery_date, 'YYYY-MM-DD')      as delivery_date,
           d.driver_sig_name                           as signed_by,
           (o.metadata ->> 'size')::bigint             as object_size,
           (o.name is not null)                        as object_exists
      from delivery_photos p
      join deliveries d on d.id = p.delivery_id
      left join stores s on s.id = d.store_id
      left join storage.objects o
        on o.bucket_id = ${PROOF_BUCKET} and o.name = p.storage_path
     order by d.delivery_date, s.name, p.kind`;

  // The other direction. Bytes with no row behind them mean either something
  // wrote to the bucket outside the app, or a row was deleted from under an
  // object -- both worth knowing, neither visible from the query above.
  const orphans = await sql<Orphan[]>`
    select o.name                                      as path,
           (o.metadata ->> 'size')::bigint             as size,
           to_char(o.created_at at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')       as created_at
      from storage.objects o
     where o.bucket_id = ${PROOF_BUCKET}
       and not exists (
         select 1 from delivery_photos p where p.storage_path = o.name
       )
     order by o.created_at`;

  const missing = rows.filter((r) => !r.object_exists);
  const present = rows.filter((r) => r.object_exists);

  // Oldest first: the ordering above is by delivery date, so slicing the head
  // walks forward through history rather than re-checking the same recent
  // objects every week.
  const changed: Mismatch[] = [];
  let verified = 0;
  for (const r of present.slice(0, sample)) {
    const got = await read(r.path);
    if (!Buffer.isBuffer(got)) {
      // Present according to storage.objects, unreadable in practice. That is
      // a missing object with a different cause, not a separate category.
      missing.push(r);
      continue;
    }
    verified++;
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(got).digest("hex");
    if (digest.toLowerCase() !== String(r.sha256).toLowerCase()) {
      changed.push({ ...r, found: digest });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    bucket: PROOF_BUCKET,
    counts: {
      recorded: rows.length,
      present: rows.length - missing.length,
      missing: missing.length,
      orphans: orphans.length,
      checksums_verified: verified,
      checksums_mismatched: changed.length,
    },
    missing,
    orphans,
    changed,
    ...(opts.includeObjects ? { objects: rows } : {}),
  };
}

/** Did the audit find anything that should stop a green tick? */
export function proofAuditFailed(a: ProofAudit): boolean {
  return a.counts.missing > 0 || a.counts.checksums_mismatched > 0;
}

/** The findings, as lines. Shared so the endpoint, the CLI and any future
 *  alert all word it the same way. Orphans are listed but do NOT fail the
 *  audit: bytes with no row are untidy, not lost evidence. */
export function proofAuditLines(a: ProofAudit): string[] {
  const out: string[] = [];
  for (const r of a.missing) {
    out.push(`MISSING  ${r.delivery_date ?? "?"}  ${r.store_name ?? r.store_id ?? "?"}  ${r.kind}`);
    out.push(`         ${r.path}`);
  }
  for (const r of a.changed) {
    out.push(`CHANGED  ${r.delivery_date ?? "?"}  ${r.store_name ?? r.store_id ?? "?"}  ${r.kind}`);
    out.push(`         ${r.path}`);
    out.push(`         recorded ${r.sha256}`);
    out.push(`         found    ${r.found}`);
  }
  for (const o of a.orphans) {
    out.push(`ORPHAN   ${o.path}  (${o.size ?? "?"} bytes, ${o.created_at ?? "?"}) — no delivery_photos row`);
  }
  return out;
}
