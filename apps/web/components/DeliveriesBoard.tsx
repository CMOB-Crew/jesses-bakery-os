"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { DeliveryLine } from "@/lib/queries";

// Interactive delivery order sheet. The engine writes the plan; Simona can
// nudge any store's Final delivery number, totals recalc live, and one button
// puts it all back. Nothing sends until she approves — this is a working sheet.
export default function DeliveriesBoard({ lines }: { lines: DeliveryLine[] }) {
  const original = useMemo(
    () => Object.fromEntries(lines.map((l) => [l.store_id, l.recommended])) as Record<string, number>,
    [lines],
  );
  const [plan, setPlan] = useState<Record<string, number>>(original);

  const val = (id: string) => plan[id] ?? original[id] ?? 0;
  const set = (id: string, n: number) => setPlan((p) => ({ ...p, [id]: Math.max(0, n) }));
  const dirty = lines.some((l) => val(l.store_id) !== original[l.store_id]);

  const totalSent = lines.reduce((a, l) => a + l.sent, 0);
  const totalPlan = lines.reduce((a, l) => a + val(l.store_id), 0);
  const trim = totalSent - totalPlan;

  // group by region, worst over-supply first (against the current plan)
  const byRegion = new Map<string, DeliveryLine[]>();
  for (const l of lines) {
    const k = l.region ?? "Unassigned";
    if (!byRegion.has(k)) byRegion.set(k, []);
    byRegion.get(k)!.push(l);
  }
  const regions = [...byRegion.entries()]
    .map(([region, ls]) => ({
      region,
      ls,
      sent: ls.reduce((a, l) => a + l.sent, 0),
      plan: ls.reduce((a, l) => a + val(l.store_id), 0),
    }))
    .sort((a, b) => (b.sent - b.plan) - (a.sent - a.plan));

  return (
    <>
      <div className="panel">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, lineHeight: 1.6 }}>
              Across the stores on plan, you&apos;re sending <b>{totalSent.toLocaleString("en-AU")}</b> units this week; sized to what actually sells, the plan sends{" "}
              <b>{totalPlan.toLocaleString("en-AU")}</b>
              {trim > 0 ? (
                <> — <b style={{ color: "var(--green)" }}>{trim.toLocaleString("en-AU")} less</b>, sized to real demand.</>
              ) : trim < 0 ? (
                <> — <b style={{ color: "var(--amber)" }}>{(-trim).toLocaleString("en-AU")} more</b> after your adjustments.</>
              ) : (
                <>.</>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 10 }}>
              Mature Woolworths feed. Final delivery is the number that actually goes out to each store — nudge any of them below; nothing sends until you approve. Green trims over-supply (less waste); amber adds cover where a store ran short.
            </div>
          </div>
          {dirty && (
            <button className="btn" type="button" onClick={() => setPlan(original)} style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
              ↺ Reset to plan
            </button>
          )}
        </div>
      </div>

      {regions.map((r) => {
        const rTrim = r.sent - r.plan;
        return (
          <div key={r.region} style={{ marginTop: 22 }}>
            <div className="section-h" style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span><span className="tick" />{r.region}</span>
              <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>
                {r.sent.toLocaleString("en-AU")} → {r.plan.toLocaleString("en-AU")}
                {rTrim > 0 ? <span style={{ color: "var(--green)" }}> · {rTrim.toLocaleString("en-AU")} less</span> : null}
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Store</th><th className="num">Sending now</th><th className="num">Final delivery</th><th className="num">Change</th></tr>
                </thead>
                <tbody>
                  {[...r.ls]
                    .sort((a, b) => (b.sent - val(b.store_id)) - (a.sent - val(a.store_id)))
                    .map((l) => {
                      const v = val(l.store_id);
                      const d = l.sent - v;
                      const edited = v !== original[l.store_id];
                      return (
                        <tr key={l.store_id}>
                          <td className="strong"><Link href={`/store/${l.store_id}`}>{l.name}</Link></td>
                          <td className="num">{l.sent}</td>
                          <td className="num">
                            <span className="stepper">
                              <button type="button" aria-label={`decrease ${l.name}`} onClick={() => set(l.store_id, v - 1)}>−</button>
                              <span className="sv" style={edited ? { color: "var(--crust, #b0741c)", fontWeight: 700 } : { fontWeight: 600 }}>{v}</span>
                              <button type="button" aria-label={`increase ${l.name}`} onClick={() => set(l.store_id, v + 1)}>+</button>
                            </span>
                          </td>
                          <td className="num" style={{ color: d > 0 ? "var(--green)" : d < 0 ? "var(--amber)" : "var(--muted)", fontWeight: 600 }}>
                            {d > 0 ? `−${d}` : d < 0 ? `+${-d}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <style>{`
        .stepper { display:inline-flex; align-items:center; gap:8px; justify-content:flex-end; }
        .stepper button {
          width:22px; height:22px; border:1px solid var(--line); background:var(--card);
          border-radius:6px; cursor:pointer; color:var(--ink2); font-size:14px; line-height:1;
          display:inline-flex; align-items:center; justify-content:center; padding:0; font-family:inherit;
          transition:.12s ease-out;
        }
        .stepper button:hover { background:#f6f0e6; color:var(--ink); }
        .stepper button:active { transform:scale(.9); }
        .stepper .sv { min-width:26px; text-align:right; font-variant-numeric:tabular-nums; }
      `}</style>
    </>
  );
}
