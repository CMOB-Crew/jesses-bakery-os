/**
 * backup-sync-check.ts — condition 9, the half that is ours.
 *
 * "Point-in-time recovery plus an independent weekly dump into storage Jesse
 * controls." — @Fred, condition 9 of fifteen.
 *
 * Supabase's own documentation: "Database backups do not include objects you
 * store via the Storage API." So the delivery photographs and the customers'
 * signatures are in NO backup. The signed record survives in Postgres and the
 * image does not, and the image is what settles a retailer dispute.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 *
 * lib/backup/sync.ts takes its database, its network and its destination as
 * dependencies, so every path through it is exercised here against fakes --
 * including the failure paths, which are the ones that matter and the ones
 * nobody ever tries by hand. No credentials, no network, runs in CI.
 *
 * What it cannot prove is the PUT to SharePoint itself, because that needs a
 * consent only Jesse can grant. That is deliberately ONE named function in
 * lib/backup/transport.ts rather than logic spread through this module, so
 * the untested surface is as small as it can be and is obvious.
 *
 * Run:  npx tsx scripts/backup-sync-check.ts
 */
import {
  syncOnce, gradeRun, remotePathFor, stalenessVerdict,
  STALE_AFTER_HOURS, DEFAULT_LIMIT,
  type SourceObject, type SyncDeps, type UploadedRow,
} from "../lib/backup/sync";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

/* ---------------------------------------------------------------- *
 * A fake world. Every dependency records what it was asked to do, so
 * the assertions can be about behaviour rather than return values.
 * ---------------------------------------------------------------- */
function world(opts: {
  pending: SourceObject[];
  failDownloadOn?: string[];
  failPutOn?: string[];
  emptyOn?: string[];
}) {
  const put: { remotePath: string; bytes: number; contentType: string }[] = [];
  const recorded: UploadedRow[] = [];
  const downloaded: string[] = [];

  const deps: SyncDeps = {
    transport: {
      name: "fake",
      async put(remotePath, bytes, contentType) {
        const src = remotePath.replace(/^driver-proof\//, "");
        if (opts.failPutOn?.some((p) => src.includes(p))) {
          throw new Error("the destination refused the write");
        }
        put.push({ remotePath, bytes: bytes.length, contentType });
      },
    },
    async listPending(limit) {
      return opts.pending.slice(0, limit);
    },
    async download(storagePath) {
      downloaded.push(storagePath);
      if (opts.failDownloadOn?.some((p) => storagePath.includes(p))) {
        throw new Error("the object is not in the bucket");
      }
      if (opts.emptyOn?.some((p) => storagePath.includes(p))) return new Uint8Array(0);
      return new Uint8Array(56_000);
    },
    async recordObject(row) {
      recorded.push(row);
    },
    contentTypeFor: () => "image/jpeg",
  };

  return { deps, put, recorded, downloaded };
}

const obj = (p: string): SourceObject => ({ storagePath: p, sha256: "sha-" + p });

/* ---------------------------------------------------------------- *
 * Where things land.
 * ---------------------------------------------------------------- */
/* Wrapped rather than left at top level: tsx transforms these scripts to
 * CJS, where top-level await is a build error. It works under an ESM
 * package and fails in this repo, which is the worst way to find out. */
async function main() {
  console.log("— the remote path —\n");

  check("derived only from the source path, so a re-run computes the same key",
    remotePathFor("2026-09-04/abc/photo-1.jpg") === remotePathFor("2026-09-04/abc/photo-1.jpg"));

  check("lands under one prefix",
    remotePathFor("2026-09-04/abc/photo-1.jpg") === "driver-proof/2026-09-04/abc/photo-1.jpg",
    remotePathFor("2026-09-04/abc/photo-1.jpg"));

  check("cannot climb out of the backup folder",
    remotePathFor("../../etc/passwd") === "driver-proof/etc/passwd",
    "a backup writing outside its own folder is a bad way to find out a path escaped");

  check("a single dot segment is dropped too",
    remotePathFor("a/./b.jpg") === "driver-proof/a/b.jpg");

  check("empty input throws rather than writing to the folder root",
    (() => { try { remotePathFor("///"); return false; } catch { return true; } })());

  /* ---------------------------------------------------------------- *
   * The happy path.
   * ---------------------------------------------------------------- */
  console.log("\n— a clean run —\n");

  {
    const w = world({ pending: [obj("a/1.jpg"), obj("a/2.jpg"), obj("a/3.jpg")] });
    const s = await syncOnce(w.deps, { limit: 10 });

    check("every pending object is uploaded", s.uploaded === 3 && w.put.length === 3);
    check("every upload is recorded", w.recorded.length === 3);
    check("bytes are counted", s.bytes === 168_000, String(s.bytes));
    check("no failures", s.failures.length === 0);
    check("not reported as having more waiting", s.moreWaiting === false);
    check("the recorded row carries the destination",
      w.recorded[0].destination === "fake");
    check("the recorded row carries the sha256 we listed, not a recomputed one",
      w.recorded[0].sha256 === "sha-a/1.jpg",
      "so a changed source object stops matching and gets picked up again");
    check("graded ok", gradeRun(s).status === "ok");
  }

  {
    const w = world({ pending: [] });
    const s = await syncOnce(w.deps, { limit: 10 });
    check("nothing to do is a SUCCESS, not a failure",
      s.considered === 0 && gradeRun(s).status === "ok",
      "most weeks right now have no new photographs; a failure here would train everyone to ignore the alarm");
  }

  /* ---------------------------------------------------------------- *
   * The failure paths. The reason this file exists.
   * ---------------------------------------------------------------- */
  console.log("\n— when one object fails —\n");

  {
    const w = world({
      pending: [obj("a/1.jpg"), obj("a/BAD.jpg"), obj("a/3.jpg")],
      failDownloadOn: ["BAD"],
    });
    const s = await syncOnce(w.deps, { limit: 10 });

    check("THE OTHER OBJECTS STILL COPY",
      s.uploaded === 2 && w.put.length === 2,
      "opposite rule to the invoice: nine photographs saved beats none saved");
    check("the failure is reported", s.failures.length === 1);
    check("the failure names the object", s.failures[0].storagePath === "a/BAD.jpg");
    check("NO ROW IS WRITTEN FOR THE FAILED OBJECT",
      !w.recorded.some((r) => r.storagePath === "a/BAD.jpg"),
      "which is what makes the next run retry it with nobody doing anything");
    check("the run is still graded failed, so the alarm goes off",
      gradeRun(s).status === "failed");
    check("the grade names the first failure and counts the rest",
      /a\/BAD\.jpg/.test(gradeRun(s).error ?? ""),
      gradeRun(s).error ?? "");
  }

  {
    const w = world({
      pending: [obj("a/1.jpg"), obj("a/NOPUT.jpg")],
      failPutOn: ["NOPUT"],
    });
    const s = await syncOnce(w.deps, { limit: 10 });
    check("a destination that refuses the write is a failure, not a silent skip",
      s.failures.length === 1 && s.uploaded === 1);
    check("and nothing is recorded for it",
      !w.recorded.some((r) => r.storagePath === "a/NOPUT.jpg"));
  }

  {
    const w = world({ pending: [obj("a/EMPTY.jpg")], emptyOn: ["EMPTY"] });
    const s = await syncOnce(w.deps, { limit: 10 });
    check("a zero-byte source is a failure, not a backed-up photograph",
      s.failures.length === 1 && s.uploaded === 0,
      "recording it would mean the real object never gets picked up again");
    check("and it never reaches the destination", w.put.length === 0);
  }

  /* ---------------------------------------------------------------- *
   * The bite size.
   * ---------------------------------------------------------------- */
  console.log("\n— the bite —\n");

  {
    const many = Array.from({ length: 25 }, (_, i) => obj(`a/${i}.jpg`));
    const w = world({ pending: many });
    const s = await syncOnce(w.deps, { limit: 10 });

    check("never uploads more than the limit", s.uploaded === 10 && w.put.length === 10);
    check("says there is more waiting", s.moreWaiting === true);
    check("HITTING THE LIMIT IS NOT A FAILURE",
      gradeRun(s).status === "ok",
      "a first run against a year of photographs would otherwise alarm every week until it caught up");
    check("the extra object it looked at is never uploaded",
      !w.put.some((p) => p.remotePath.endsWith("/10.jpg")),
      "the limit+1 read only answers 'is there more'");
    check("the default bite is documented and sane",
      DEFAULT_LIMIT > 0 && DEFAULT_LIMIT <= 1000, String(DEFAULT_LIMIT));
  }

  /* ---------------------------------------------------------------- *
   * Staleness. The thing that actually bites.
   * ---------------------------------------------------------------- */
  console.log("\n— the staleness alarm —\n");

  check("never having run is stale, and says so plainly",
    stalenessVerdict(null).stale &&
    /no backup has ever/i.test(stalenessVerdict(null).says),
    stalenessVerdict(null).says);

  check("the stale message never reads as a contradiction at the boundary",
    !/(\d+) days ago, past the \1 day/.test(stalenessVerdict(STALE_AFTER_HOURS + 1).says),
    "'8 days ago, past the 8 day limit' is what a person reads at six in the morning");

  check("a backup from today is not stale",
    !stalenessVerdict(2).stale, stalenessVerdict(2).says);

  check("a week old is not stale, because the schedule is weekly",
    !stalenessVerdict(24 * 7).stale, stalenessVerdict(24 * 7).says);

  check("past the limit is stale",
    stalenessVerdict(STALE_AFTER_HOURS + 1).stale,
    stalenessVerdict(STALE_AFTER_HOURS + 1).says);

  check("and it names the credential first",
    /credential|secret/i.test(stalenessVerdict(STALE_AFTER_HOURS + 1).says),
    "@Fred: the secret expires and the backup silently stops, same way TriggerForecastRefreshADF died");

  check("the limit leaves slack for one missed run",
    STALE_AFTER_HOURS > 24 * 7, `${STALE_AFTER_HOURS}h`);
}

main().then(() => {
  console.log(
    fails === 0
      ? "\n  All checks pass. The sync copies what it can, reports what it cannot,\n" +
        "  and a backup that has stopped cannot look like one with nothing to do.\n"
      : `\n  ${fails} FAILED\n`,
  );
  process.exit(fails === 0 ? 0 : 1);
});
