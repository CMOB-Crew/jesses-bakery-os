"use client";
import { useMemo, useState } from "react";

/* ------------------------------------------------------------------ *
 * Store benchmarking — Simona's rule: never grade a store against one
 * absolute target. Each store is measured against (1) its own expected
 * performance and (2) similar same-size stores in its region. That's how
 * a small Canberra store and a big Bondi store are judged fairly — and
 * it's the fairness layer behind the R/A/G flags used everywhere.
 *
 * Metric shown: sell-through % (sold ÷ delivered). Front-end prototype;
 * cohorts and scoring are the engine's, this surfaces them.
 * ------------------------------------------------------------------ */

type Store = { name: string; region: string; size: "Small" | "Medium" | "Large"; sell: number; expected: number };

const STORES: Store[] = [
  // Eastern Suburbs · Large
  { name: "Woolworths Bondi Beach", region: "Eastern Suburbs", size: "Large", sell: 91, expected: 88 },
  { name: "Woolworths Bondi Junction", region: "Eastern Suburbs", size: "Large", sell: 88, expected: 86 },
  { name: "Coles Double Bay", region: "Eastern Suburbs", size: "Large", sell: 84, expected: 85 },
  { name: "Woolworths Randwick", region: "Eastern Suburbs", size: "Large", sell: 79, expected: 86 },
  // Inner West · Medium
  { name: "Coles Ashfield", region: "Inner West", size: "Medium", sell: 90, expected: 85 },
  { name: "Coles Marrickville", region: "Inner West", size: "Medium", sell: 83, expected: 84 },
  { name: "Harris Farm Leichhardt", region: "Inner West", size: "Medium", sell: 81, expected: 83 },
  // Canberra · Medium
  { name: "Woolworths Woden", region: "Canberra / ACT", size: "Medium", sell: 76, expected: 78 },
  { name: "Woolworths Tuggeranong", region: "Canberra / ACT", size: "Medium", sell: 74, expected: 77 },
  { name: "Coles Belconnen", region: "Canberra / ACT", size: "Medium", sell: 72, expected: 78 },
  { name: "Woolworths Gungahlin", region: "Canberra / ACT", size: "Medium", sell: 70, expected: 79 },
];

function median(ns: number[]) {
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export default function StoreBenchmarks() {
  const cohorts = useMemo(() => {
    const map = new Map<string, Store[]>();
    for (const s of STORES) {
      const key = `${s.region} · ${s.size}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()].map(([key, stores]) => ({
      key, stores: [...stores].sort((a, b) => b.sell - a.sell), med: median(stores.map((s) => s.sell)),
    }));
  }, []);

  const [sel, setSel] = useState("Canberra / ACT · Medium");
  const cohort = cohorts.find((c) => c.key === sel) ?? cohorts[0];

  // Per-store deltas vs cohort median + own expected
  const scored = STORES.map((s) => {
    const med = cohorts.find((c) => c.key === `${s.region} · ${s.size}`)!.med;
    return { ...s, med, vCohort: s.sell - med, vExpected: s.sell - s.expected };
  });
  const under = scored.filter((s) => s.vCohort <= -3).sort((a, b) => a.vCohort - b.vCohort);
  const over = scored.filter((s) => s.vCohort >= 3).sort((a, b) => b.vCohort - a.vCohort);
  const networkMed = median(STORES.map((s) => s.sell));

  // Bar scale
  const LO = 55, HI = 95;
  const w = (v: number) => `${Math.max(2, ((v - LO) / (HI - LO)) * 100)}%`;
  const status = (d: number) => (d >= 3 ? "green" : d <= -3 ? "red" : "amber");

  return (
    <div className="bench">
      <div className="panel intro">
        <div className="itxt">
          We never grade a store against one number. Each is measured against its <b>own expected performance</b> and
          against <b>similar same-size stores in its region</b> — so a small Canberra store and a big Bondi store are
          judged fairly. This is the fairness layer behind every 🟢🟡🔴 flag in the system.
        </div>
      </div>

      {/* Strip */}
      <div className="strip">
        <div className="tile"><div className="tn">{cohorts.length}</div><div className="tl">Peer cohorts · size × region</div></div>
        <div className="tile"><div className="tn red">{under.length}</div><div className="tl">Below their peers · real underperformers</div></div>
        <div className="tile"><div className="tn green">{over.length}</div><div className="tl">Above their peers · worth learning from</div></div>
        <div className="tile"><div className="tn">{networkMed}<span className="u">%</span></div><div className="tl">Network median sell-through</div></div>
      </div>

      {/* Cohort explorer */}
      <div className="section-h" style={{ marginTop: 20, marginBottom: 10 }}><span className="tick" />Cohort explorer</div>
      <div className="cohortpick">
        {cohorts.map((c) => (
          <button key={c.key} className={c.key === sel ? "on" : ""} onClick={() => setSel(c.key)}>
            {c.key}<small>{c.stores.length} stores</small>
          </button>
        ))}
      </div>

      <div className="panel cohortcard">
        <div className="cc-h">
          <div className="cc-title">{cohort.key}</div>
          <div className="cc-med">Cohort median <b>{cohort.med}%</b></div>
        </div>
        <div className="bars">
          {cohort.stores.map((s) => {
            const d = s.sell - cohort.med;
            return (
              <div className="barrow" key={s.name}>
                <div className="bl">{s.name}</div>
                <div className="btrack">
                  <div className={`bfill ${status(d)}`} style={{ width: w(s.sell) }} />
                  <div className="bmed" style={{ left: w(cohort.med) }} title="cohort median" />
                  <span className="bval">{s.sell}%</span>
                </div>
                <div className={`bd ${status(d)}`}>{d > 0 ? "+" : ""}{d} vs peers</div>
              </div>
            );
          })}
        </div>
        {sel.startsWith("Canberra") && (
          <div className="insight">
            An absolute 85% target would flag all four of these red. Peer-relative, <b>Woden</b> is actually above its
            cohort and doing fine <i>for Canberra</i> — the real problem is <b>Gungahlin</b>, below both its peers and its
            own expected. That&apos;s the difference between punishing a hard region and finding the store that needs help.
          </div>
        )}
      </div>

      {/* Outliers table */}
      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Outliers to act on</div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Store</th><th>Cohort</th><th className="num">Sell-through</th><th className="num">vs peers</th><th className="num">vs own expected</th><th>Read</th></tr>
          </thead>
          <tbody>
            {[...under, ...over].map((s) => (
              <tr key={s.name}>
                <td className="strong">{s.name}</td>
                <td className="dim">{s.region} · {s.size}</td>
                <td className="num">{s.sell}%</td>
                <td className="num"><span className={`pill ${status(s.vCohort)}`}>{s.vCohort > 0 ? "+" : ""}{s.vCohort}</span></td>
                <td className="num"><span className={`pill ${status(s.vExpected)}`}>{s.vExpected > 0 ? "+" : ""}{s.vExpected}</span></td>
                <td className="read">
                  {s.vCohort <= -3
                    ? "Underperforming its peers — check range, delivery days and sellout timing."
                    : "Beating its peers — a pattern worth copying to the cohort."}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        Representative. Sell-through is sold ÷ delivered; cohorts are size × region. Every store is scored against its
        cohort median and its own baseline — never one network target — and that score drives the R/A/G flags across the app.
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
