"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createRun } from "@/app/new-store/actions";
import type { RunWithCount } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * New run — Setup, 1 Sept call.
 *
 * createRun already existed and already worked, but the only door to it
 * was a "＋ Create a new run…" option buried in the retailer dropdown of
 * the New store wizard. To make a run you had to start adding a store
 * you did not want, and Simona's own words on 26 Aug were that the run
 * has to be creatable BEFORE the store:
 *
 *   "Delivery Run has to be created before the store if the store
 *    belongs to a new run. So Setup needs a create-new-run option."
 *
 * So this is one door, not a second implementation — it calls the same
 * server action. What it adds is the list: the live case is splitting an
 * over-full South East and pulling East Village off Hills, and you
 * cannot judge that without seeing how many stores each run carries.
 * ------------------------------------------------------------------ */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

export default function NewRunSetup({ runs }: { runs: RunWithCount[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [days, setDays] = useState<Record<string, boolean>>({ Mon: true, Tue: false, Wed: true, Thu: false, Fri: true, Sat: false, Sun: false });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const chosen = DAYS.filter((d) => days[d]);
  const clash = runs.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null;
  const blocked = !name.trim() || !chosen.length || !!clash;

  function submit() {
    setMsg(null);
    start(async () => {
      const res = await createRun(name.trim(), chosen.map((d) => d.toLowerCase()));
      if (res.ok) {
        setMsg({ ok: true, text: `${res.name} created, going out ${chosen.join(", ")}. Put stores on it from New store, or move existing ones from Delivery Runs.` });
        setName("");
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  // MEASURED ON THE LIVE SITE, 2 Sept: 34 run rows, and 20 of them have no days
  // and no stores. They are named "Run 1" and they are scaffolding -- everything
  // else in the app filters on cardinality(run_days) > 0, so /map and the New
  // store dropdown have never shown them and nobody has ever seen one.
  //
  // Listing them alongside the real runs made this page open with "34 runs, 20
  // with nothing on them yet", which reads like an alarm about the business when
  // it is an artefact of the data load. Real runs get the list; the dayless ones
  // get one quiet line, because hiding them entirely would mean this page lies
  // about what is in the table.
  const real = runs.filter((r) => r.days.length > 0);
  const legacy = runs.length - real.length;
  const empty = real.filter((r) => r.stores === 0).length;

  return (
    <div className="nrun">
      <div className="grid2">
        <div className="main">
          <div className="sec">
            <div className="sec-h">Create a run</div>
            <div className="lead">
              A run is the van and the days it goes out. Name it after where it goes, not a number — Simona&apos;s rule, so the
              same stores are always on the same named run as the network grows.
            </div>
            <label className="fld">
              <span>Run name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. City 2" maxLength={60} />
            </label>
            {clash && <div className="warn">There is already a run called <b>{clash.name}</b>.</div>}
            <div className="fld dayfld">
              <span>Days this run goes out</span>
              <div className="days">
                {DAYS.map((d) => (
                  <button key={d} type="button" className={days[d] ? "on" : ""} onClick={() => setDays((x) => ({ ...x, [d]: !x[d] }))}>{d}</button>
                ))}
              </div>
            </div>
            <div className="note">
              These days are the run&apos;s norm and get copied onto each store you add to it. A store can still take fewer —
              the store&apos;s own days are what the forecast engine reads.
            </div>
            <button className="save" disabled={pending || blocked} onClick={submit}>
              {pending ? "Creating…" : "Create run"}
            </button>
            {msg && <div className={`msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
          </div>
        </div>

        <aside className="rail">
          <div className="sec">
            <div className="sec-h">Runs today</div>
            <div className="lead">
              {real.length} run{real.length === 1 ? "" : "s"}, carrying {real.reduce((a, r) => a + r.stores, 0)} active stores
              {empty > 0 ? ` · ${empty} with nothing on ${empty === 1 ? "it" : "them"} yet` : ""}.
            </div>
            <div className="rlist">
              {real.map((r) => (
                <div className="rrow" key={r.id}>
                  <div className="rn">
                    {r.name}
                    <small>{r.days.length ? r.days.map((d) => LABEL[d] ?? d).join(" · ") : "no days set"}</small>
                  </div>
                  <span className={`rc ${r.stores === 0 ? "zero" : ""}`}>{r.stores}</span>
                </div>
              ))}
              {real.length === 0 && <div className="note">No runs loaded.</div>}
            </div>
            {legacy > 0 && (
              <div className="legacy">
                {legacy} older run record{legacy === 1 ? "" : "s"} with no days and no stores, left over from the data load.
                Nothing else in the app shows {legacy === 1 ? "it" : "them"} and nothing depends on {legacy === 1 ? "it" : "them"}.
              </div>
            )}
            <a className="rlink" href="/map">Move stores between runs →</a>
          </div>
        </aside>
      </div>

      <style>{`
        .nrun .grid2{display:grid;grid-template-columns:1.35fr 1fr;gap:18px;align-items:start}
        .nrun .main{display:flex;flex-direction:column;gap:16px;min-width:0}
        .nrun .sec{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px}
        .nrun .sec-h{font-family:var(--serif);font-size:16px;font-weight:600;margin-bottom:10px}
        .nrun .lead{font-size:12.5px;color:var(--ink2);line-height:1.55;margin-bottom:14px}
        .nrun .fld{display:flex;flex-direction:column;gap:6px;min-width:0}
        .nrun .fld>span{font-size:12px;font-weight:600;color:var(--ink2)}
        .nrun .dayfld{margin-top:14px}
        .nrun input{border:1px solid var(--line);border-radius:9px;padding:9px 11px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none;width:100%}
        .nrun input:focus{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
        .nrun .days{display:flex;gap:6px;flex-wrap:wrap}
        .nrun .days button{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:9px 13px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit}
        .nrun .days button.on{background:var(--crust);border-color:var(--crust);color:#fff}
        .nrun .note{font-size:12px;color:var(--muted);line-height:1.55;margin-top:12px}
        .nrun .warn{margin-top:11px;background:var(--red-b,#f7e4e0);border:1px solid #eab9a8;border-radius:9px;padding:9px 12px;font-size:12.5px;color:var(--red-t,#a4372a)}
        .nrun .save{margin-top:16px;border:none;background:var(--espresso);color:#f7efdd;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
        .nrun .save:disabled{opacity:.45;cursor:default}
        .nrun .msg{margin-top:12px;font-size:12.5px;font-weight:600;border-radius:9px;padding:10px 12px;line-height:1.5}
        .nrun .msg.ok{background:var(--green-b);color:var(--green-t);border:1px solid var(--green)}
        .nrun .msg.err{background:var(--red-b,#f7e4e0);color:var(--red-t,#a4372a);border:1px solid var(--red,#c0563f)}
        .nrun .rail{position:sticky;top:16px}
        .nrun .rlist{display:flex;flex-direction:column}
        .nrun .rrow{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--line2)}
        .nrun .rrow:last-child{border-bottom:none}
        .nrun .rn{flex:1;min-width:0;font-size:13.5px;font-weight:600;display:flex;flex-direction:column;line-height:1.3;overflow-wrap:anywhere}
        .nrun .rn small{font-size:11px;color:var(--muted);font-weight:500;margin-top:2px}
        .nrun .rc{flex:none;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--line2);color:var(--ink2);border-radius:999px;padding:3px 11px}
        .nrun .rc.zero{background:var(--amber-b);color:var(--amber-t)}
        .nrun .legacy{margin-top:12px;font-size:11.5px;color:var(--faint);line-height:1.5}
        .nrun .rlink{display:inline-block;margin-top:14px;font-size:12.5px;font-weight:600;color:var(--crust-deep);text-decoration:underline}
        @media (max-width:1000px){
          .nrun .grid2{grid-template-columns:1fr}
          .nrun .rail{position:static}
        }
        @media (max-width:620px){
          .nrun .sec{padding:15px 14px}
        }
      `}</style>
    </div>
  );
}
