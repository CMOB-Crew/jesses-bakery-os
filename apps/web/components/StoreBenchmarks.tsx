"use client";
import { useState } from "react";
import Link from "next/link";
import type { Benchmarks } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Store benchmarking — Simona's rule: never grade a store against one
 * absolute target. Each store is scored against similar same-size stores
 * in its region (the cohort) and against its own last week. Live data
 * from v_store_week (sell-through = sold / delivered). This is the
 * fairness layer behind the R/A/G flags.
 * ------------------------------------------------------------------ */

type Status = "green" | "amber" | "red";
const status = (d: number) => (d >= 3 ? "green" : d <= -3 ? "red" : "amber") as Status;

export default function StoreBenchmarks({ data }: { data: Benchmarks }) {
  const [sel, setSel] = useState(data.cohorts[0]?.key ?? "");
  const cohort = data.cohorts.find((c) => c.key === sel) ?? data.cohorts[0];

  if (!data.hasData || !cohort) {
    return (
      <div className="bench">
        <div className="panel intro">
          <div className="itxt">
            We never grade a store against one number — each is measured against similar stores on the same feed in its
            region (retail scan vs direct invoice), so a Woolworths shelf is never judged against a cafe that invoices
            exactly what it sells. This lights up once at least two comparable stores share a cohort. As the ledger fills
            across Coles and Harris Farm, the cohorts complete.
          </div>
        </div>
      </div>
    );
  }

  const absRed = cohort.stores.filter((s) => s.sell < 85).length;
  const best = cohort.stores[0];
  const worst = cohort.stores[cohort.stores.length - 1];
  const LO = 40, HI = 100;
  const w = (v: number) => `${Math.min(100, Math.max(2, ((v - LO) / (HI - LO)) * 100))}%`;

  return (
    <div className="bench">
      <div className="panel intro">
        <div className="itxt">
          We never grade a store against one number. Each is measured against its <b>own last week</b> and against
          <b> similar stores on the same feed in its delivery run</b> — retail-scan stores against retail, direct-invoice
          against invoice — so a Woolworths shelf is never held to a cafe&apos;s 100%. This is the fairness layer behind
          every 🟢🟡🔴 flag in the system.
        </div>
      </div>

      <div className="strip">
        <div className="tile"><div className="tn">{data.cohortCount}</div><div className="tl">Peer cohorts · delivery run × channel × size</div></div>
        <div className="tile"><div className="tn red">{data.under.length}</div><div className="tl">Below their peers · real underperformers</div></div>
        <div className="tile"><div className="tn green">{data.over.length}</div><div className="tl">Above their peers · worth learning from</div></div>
        <div className="tile"><div className="tn">{data.networkMedian ?? "—"}<span className="u">%</span></div><div className="tl">Network median sell-through</div></div>
      </div>

      <div className="section-h" style={{ marginTop: 20, marginBottom: 10 }}><span className="tick" />Cohort explorer</div>
      <div className="cohortpick">
        {data.cohorts.map((c) => (
          <button key={c.key} className={c.key === sel ? "on" : ""} onClick={() => setSel(c.key)}>
            {c.key}<small>{c.count} stores</small>
          </button>
        ))}
      </div>

      <div className="panel cohortcard">
        <div className="cc-h">
          <div className="cc-title">{cohort.key}</div>
          <div className="cc-med">Cohort median <b>{cohort.median}%</b></div>
        </div>
        <div className="bars">
          {cohort.stores.map((s) => {
            const d = Math.round((s.sell - cohort.median) * 10) / 10;
            return (
              <div className="barrow" key={s.store_id}>
                <div className="bl"><Link prefetch={false} href={`/store/${s.store_id}`}>{s.name}</Link></div>
                <div className="btrack">
                  <div className={`bfill ${status(d)}`} style={{ width: w(s.sell) }} />
                  <div className="bmed" style={{ left: w(cohort.median) }} title="cohort median" />
                  <span className="bval">{s.sell}%</span>
                </div>
                <div className={`bd ${status(d)}`}>{d > 0 ? "+" : ""}{d} vs peers</div>
              </div>
            );
          })}
        </div>
        <div className="insight">
          An absolute 85% target would flag <b>{absRed} of these {cohort.count}</b> red. Peer-relative, <b>{best.name}</b> leads
          this cohort{worst.sell < best.sell ? <> and <b>{worst.name}</b> sits furthest below its peers — that&apos;s the store to look at, not the whole group.</> : <>.</>} That&apos;s
          the difference between punishing a hard region and finding the store that needs help.
        </div>
      </div>

      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Outliers to act on</div>
      {data.under.length + data.over.length === 0 ? (
        <div className="panel"><div style={{ color: "var(--ink2)", fontSize: 13.5, lineHeight: 1.6 }}>Every store is within a few points of its cohort — no clear outliers this week.</div></div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>Store</th><th>Cohort</th><th className="num">Sell-through</th><th className="num">vs peers</th><th className="num">vs last week</th><th>Read</th></tr>
            </thead>
            <tbody>
              {[...data.under, ...data.over].map((s) => (
                <tr key={s.store_id}>
                  <td className="strong"><Link prefetch={false} href={`/store/${s.store_id}`}>{s.name}</Link></td>
                  <td className="dim">{s.region} · {s.channel} · {s.size}</td>
                  <td className="num">{s.sell}%</td>
                  <td className="num"><span className={`pill ${status(s.vs_cohort ?? 0)}`}>{(s.vs_cohort ?? 0) > 0 ? "+" : ""}{s.vs_cohort}</span></td>
                  <td className="num">{s.trend === null ? <span className="dim">—</span> : <span className={`pill ${status(s.trend)}`}>{s.trend > 0 ? "+" : ""}{s.trend}%</span>}</td>
                  <td className="read">
                    {(s.vs_cohort ?? 0) <= -3
                      ? "Underperforming its peers — check range, delivery days and sellout timing."
                      : "Beating its peers — a pattern worth copying to the cohort."}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="foot" style={{ marginTop: 16 }}>
        Live from the store-week view. Sell-through is sold ÷ delivered; cohorts are region × channel (retail scan vs
        direct invoice) × size and need at least two stores to benchmark. Every store is scored against its cohort median
        and its own last week — never one network target.
      </div>

      <style>{`
        .bench .intro{margin-bottom:16px}
        .bench .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .bench .intro b{color:var(--ink);font-weight:600}
        .bench .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
        .bench .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .bench .tn{font-family:var(--serif);font-size:32px;font-weight:600;line-height:1;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
        .bench .tn .u{font-size:15px;color:var(--muted);font-family:var(--sans);font-weight:500}
        .bench .tn.green{color:var(--green-t)} .bench .tn.red{color:var(--red-t)}
        .bench .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}

        .bench .cohortpick{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
        .bench .cohortpick button{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;display:flex;flex-direction:column;gap:1px;line-height:1.2}
        .bench .cohortpick button small{font-size:11px;color:var(--muted);font-weight:500}
        .bench .cohortpick button.on{background:var(--espresso);color:#f7efdd;border-color:var(--espresso)}
        .bench .cohortpick button.on small{color:#d8c9a6}

        .bench .cohortcard{padding:20px}
        .bench .cc-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px}
        .bench .cc-title{font-family:var(--serif);font-size:17px;font-weight:600}
        .bench .cc-med{font-size:13px;color:var(--muted)}
        .bench .cc-med b{color:var(--ink);font-family:var(--serif)}
        .bench .bars{display:flex;flex-direction:column;gap:12px}
        .bench .barrow{display:grid;grid-template-columns:190px 1fr 110px;align-items:center;gap:14px}
        .bench .bl{font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .bench .bl a{color:inherit;text-decoration:none} .bench .bl a:hover{color:var(--crust-deep);text-decoration:underline}
        .bench td.strong a{color:inherit;text-decoration:none} .bench td.strong a:hover{color:var(--crust-deep);text-decoration:underline}
        .bench .btrack{position:relative;height:26px;background:var(--surface);border:1px solid var(--line2);border-radius:7px;overflow:hidden}
        .bench .bfill{position:absolute;left:0;top:0;bottom:0;border-radius:6px 0 0 6px;opacity:.9}
        .bench .bfill.green{background:var(--green)} .bench .bfill.amber{background:var(--amber)} .bench .bfill.red{background:var(--red)}
        .bench .bmed{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--espresso);opacity:.7}
        .bench .bval{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:12px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
        .bench .bd{font-size:12px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
        .bench .bd.green{color:var(--green-t)} .bench .bd.amber{color:var(--muted)} .bench .bd.red{color:var(--red-t)}
        .bench .insight{margin-top:16px;background:var(--surface);border:1px solid var(--line2);border-left:2px solid var(--crust);border-radius:9px;padding:13px 15px;font-size:13px;color:var(--ink2);line-height:1.6}
        .bench .insight b{color:var(--ink)}

        .bench td.dim{color:var(--muted);font-size:13px}
        .bench .pill{display:inline-block;font-weight:700;font-size:12.5px;padding:3px 9px;border-radius:999px;font-variant-numeric:tabular-nums}
        .bench .pill.green{background:var(--green-b);color:var(--green-t)}
        .bench .pill.amber{background:var(--amber-b);color:var(--amber-t)}
        .bench .pill.red{background:var(--red-b);color:var(--red-t)}
        .bench .read{font-size:12.5px;color:var(--ink2);max-width:320px;line-height:1.5}

        @media (max-width:1080px){ .bench .strip{grid-template-columns:1fr 1fr} .bench .barrow{grid-template-columns:130px 1fr 92px} }
      `}</style>
    </div>
  );
}
