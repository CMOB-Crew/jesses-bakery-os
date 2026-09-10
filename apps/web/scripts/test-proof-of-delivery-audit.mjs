/* The proof-of-delivery audit, exercised against a stand-in Storage API.
 *
 * The audit's whole job is to notice when a signature or a shelf photo has gone
 * missing or changed. A check like that fails silently when it breaks: it goes
 * green, nobody looks, and the thing it was watching rots. So the three answers
 * it can give are all asserted here, against a real Postgres and a fake bucket:
 *
 *   everything present and unchanged   -> exit 0
 *   an object deleted from the bucket  -> exit 1, and it names the object
 *   an object's contents swapped       -> exit 1, and it prints both checksums
 *
 * The bucket is a ~60 line http server implementing just enough of list and
 * download. Faking it rather than talking to Supabase means this runs in CI on
 * every push, with no credentials and no network, which is the only way a check
 * like this stays true.
 *
 *   DATABASE_URL=postgres://... node scripts/test-proof-of-delivery-audit.mjs
 *
 * The database is written to: it clears delivery_photos and inserts three rows
 * against a test store. Point it at the CI database or a throwaway; it refuses
 * anything that looks like Supabase.
 */

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import postgres from "postgres";

const DB = process.env.DATABASE_URL;
if (!DB) { console.error("CANNOT RUN  set DATABASE_URL to a throwaway database."); process.exit(2); }
if (/supabase\.(co|com)|pooler\.supabase/.test(DB)) {
  console.error("REFUSING: DATABASE_URL points at Supabase. This test writes to delivery_photos.");
  process.exit(2);
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const AUDIT = join(HERE, "proof-of-delivery-audit.mjs");
const sha = (s) => createHash("sha256").update(Buffer.from(s)).digest("hex");

// The three objects, and what is inside them.
const FILES = [
  ["2026-09-09/store-a/photo-11111111-1111-1111-1111-111111111111.jpg", "PHOTO-A", "photo", 1],
  ["2026-09-09/store-a/signature-22222222-2222-2222-2222-222222222222.jpg", "SIG-A", "signature", 1],
  ["2026-09-09/store-b/photo-33333333-3333-3333-3333-333333333333.jpg", "PHOTO-B", "photo", 2],
];

let pass = 0;
const fails = [];
const is = (label, got, want) => {
  if (got === want) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};
const has = (label, hay, needle) => {
  if (String(hay).includes(needle)) { pass++; return; }
  fails.push(`${label}\n      output did not contain: ${needle}`);
};

// ---------------------------------------------------------------- the bucket
function bucket(objects) {
  const map = new Map(objects);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname.startsWith("/storage/v1/object/list/")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { prefix = "", limit = 100, offset = 0 } = JSON.parse(body || "{}");
        const dir = prefix.replace(/\/$/, "");
        const out = [];
        for (const [path, content] of map) {
          const cut = path.lastIndexOf("/");
          if ((cut === -1 ? "" : path.slice(0, cut)) !== dir) continue;
          out.push({ name: cut === -1 ? path : path.slice(cut + 1), metadata: { size: Buffer.byteLength(content) } });
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.slice(offset, offset + limit)));
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/storage/v1/object/")) {
      // /storage/v1/object/<bucket>/<path...>
      const rest = decodeURIComponent(url.pathname.slice("/storage/v1/object/".length));
      const content = map.get(rest.split("/").slice(1).join("/"));
      if (content == null) { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); return; }
      res.setHeader("content-type", "image/jpeg");
      res.end(Buffer.from(content));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      // closeAllConnections, not just close. The audit runs in a child process
      // whose fetch keeps its socket alive, so close() alone waits for a
      // connection that is never coming back and the test hangs until the CI
      // job is killed. Found exactly that way.
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

// spawn, NOT spawnSync. The fake bucket runs in THIS process, so a synchronous
// child blocks the event loop that has to serve its requests -- the audit waits
// for a reply that cannot be sent and the test hangs until something kills it.
// Cost twenty minutes and a timed-out job to notice.
const run = (port, sample = "10") =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [AUDIT, "--sample", sample], {
      env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-secret" },
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });

// ---------------------------------------------------------------- the fixture
const sql = postgres(DB, { max: 2, ssl: undefined, prepare: false });

async function seed() {
  await sql`insert into regions (id, name) values ('b0000000-0000-0000-0000-0000000000f1','PoD Region') on conflict do nothing`;
  await sql`insert into runs (id, name, region_id) values ('c0000000-0000-0000-0000-0000000000f1','PoD Run','b0000000-0000-0000-0000-0000000000f1') on conflict do nothing`;
  await sql`
    insert into stores (id, name, retailer, region_id, default_run_id, active) values
     ('d0000000-0000-0000-0000-0000000000f1','PoD Store A','coles','b0000000-0000-0000-0000-0000000000f1','c0000000-0000-0000-0000-0000000000f1',true),
     ('d0000000-0000-0000-0000-0000000000f2','PoD Store B','coles','b0000000-0000-0000-0000-0000000000f1','c0000000-0000-0000-0000-0000000000f1',true)
    on conflict do nothing`;
  await sql`
    insert into deliveries (id, store_id, delivery_date, status, driver_sig_name) values
     ('f0000000-0000-0000-0000-0000000000f1','d0000000-0000-0000-0000-0000000000f1','2026-09-09','delivered','Ahmed K'),
     ('f0000000-0000-0000-0000-0000000000f2','d0000000-0000-0000-0000-0000000000f2','2026-09-09','delivered','Ahmed K')
    on conflict (store_id, delivery_date) do update set driver_sig_name = excluded.driver_sig_name`;
  await sql`delete from delivery_photos where storage_path like '2026-09-09/store-%'`;
  for (const [path, content, kind, which] of FILES) {
    const did = which === 1 ? "f0000000-0000-0000-0000-0000000000f1" : "f0000000-0000-0000-0000-0000000000f2";
    await sql`
      insert into delivery_photos (delivery_id, storage_path, sha256, kind, gps_lat, gps_lng, gps_accuracy_m)
      values (${did}::uuid, ${path}, ${sha(content)}, ${kind}, -33.89, 151.27, 8)
      on conflict (delivery_id, kind) do update
        set storage_path = excluded.storage_path, sha256 = excluded.sha256`;
  }
}

async function main() {
  await seed();

  // --- everything present and unchanged ------------------------------------
  {
    const b = await bucket(FILES.map(([p, c]) => [p, c]));
    const r = await run(b.port);
    b.close();
    is("all present: exit 0", r.code, 0);
    has("all present: says so", r.out, "present and unchanged");
    is("all present: nothing reported missing", /(\d+) missing/.exec(r.out)?.[1], "0");
  }

  // --- one object deleted from the bucket ----------------------------------
  {
    const b = await bucket(FILES.filter(([, , k]) => k !== "signature").map(([p, c]) => [p, c]));
    const r = await run(b.port);
    b.close();
    is("a deleted signature: exit 1", r.code, 1);
    has("a deleted signature: is named", r.out, "signature-22222222-2222-2222-2222-222222222222.jpg");
    has("a deleted signature: is called MISSING", r.out, "MISSING");
    // The store and the date, not just the path -- a path alone does not tell
    // anyone which drop is now unevidenced.
    has("a deleted signature: names the store", r.out, "PoD Store A");
    has("a deleted signature: names the date", r.out, "2026-09-09");
  }

  // --- one object's contents swapped ---------------------------------------
  {
    const swapped = FILES.map(([p, c, k]) => [p, k === "signature" ? "SOMEONE-ELSES-SIGNATURE" : c]);
    const b = await bucket(swapped);
    const r = await run(b.port);
    b.close();
    is("a swapped signature: exit 1", r.code, 1);
    has("a swapped signature: is called CHANGED", r.out, "CHANGED");
    has("a swapped signature: prints the recorded checksum", r.out, sha("SIG-A"));
    has("a swapped signature: prints the checksum it found", r.out, sha("SOMEONE-ELSES-SIGNATURE"));
    // Nothing is missing in this case, and saying so keeps the two failure
    // modes apart -- "the file is gone" and "the file is not the one we
    // recorded" are different conversations.
    is("a swapped signature: nothing is missing", /(\d+) missing/.exec(r.out)?.[1], "0");
  }

  // --- a deleted object, with the contents check switched OFF --------------
  // This case exists because the first version of this file did not have it,
  // and without it the suite could not tell the existence check from the
  // contents check. Deleting the whole existence branch still passed: with a
  // sample big enough to cover every object, the missing file simply 404s on
  // download and gets reported that way instead. Two mechanisms, one of them
  // untested, and the untested one is the only one that runs at scale -- the
  // sample will be 25 objects out of thousands.
  {
    const b = await bucket(FILES.filter(([, , k]) => k !== "signature").map(([p, c]) => [p, c]));
    const r = await run(b.port, "0");
    b.close();
    is("a deleted signature, no contents check: still exit 1", r.code, 1);
    has("a deleted signature, no contents check: still named", r.out, "signature-22222222-2222-2222-2222-222222222222.jpg");
    is("a deleted signature, no contents check: counted as missing", /(\d+) missing/.exec(r.out)?.[1], "1");
  }

  // --- the sample bound is respected ---------------------------------------
  // Existence is checked for everything; contents only for the sample. With
  // the sample at zero a swapped file is NOT caught, and that is the documented
  // trade, so it is asserted rather than left to be discovered.
  {
    const swapped = FILES.map(([p, c, k]) => [p, k === "signature" ? "SOMEONE-ELSES-SIGNATURE" : c]);
    const b = await bucket(swapped);
    const r = await run(b.port, "0");
    b.close();
    is("--sample 0: existence still passes", r.code, 0);
    is("--sample 0: no checksum line is printed", /checksums? verified/.test(r.out), false);
  }

  await sql`delete from delivery_photos where storage_path like '2026-09-09/store-%'`;
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
