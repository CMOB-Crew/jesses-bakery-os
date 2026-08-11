import { getEngineProjection } from "@/lib/queries";

export const metadata = { title: "Settings · Jesse's Bakery OS" };
export const revalidate = 120;

export default async function SettingsPage() {
  const scenarios = (await getEngineProjection()).filter((s) => s.scenario !== "current");
  const balanced = scenarios.find((s) => s.scenario === "balanced");

  const assumptions: { label: string; value: string; note: string }[] = [
    { label: "Shelf life", value: "~5 sellable days", note: "Stock is pulled ~2 days before expiry, so the engine plans to a 5-day sellable window." },
    { label: "Lead time", value: "Sourdough 2 days · everything else 1 day", note: "How far ahead the order has to be placed before it hits the shelf." },
    { label: "Minimum per product", value: "2 units", note: "A store carrying a line never gets sent just 1 — keeps the shelf looking stocked." },
    { label: "Demand variability", value: "±35% (starting assumption)", note: "How much week-to-week swing the safety stock covers. Tuned per line as real data builds." },
  ];

  const buffers: { type: string; buffer: string }[] = [
    { type: "Small store · delivered daily", buffer: "0%" },
    { type: "Medium store · delivered daily", buffer: "15%" },
    { type: "Large store · delivered daily", buffer: "10%" },
    { type: "Any store · every-second-day run", buffer: "20%" },
  ];

  return (
    <>
      <div className="head">
        <h1>Settings</h1>
        <div className="meta">How the engine sizes every order</div>
      </div>

      <div className="panel">
        <div style={{ fontSize: 15, lineHeight: 1.6 }}>
          The engine is not a black box. Every number below is a lever you control — this is exactly how it decides
          what to bake and send. Nothing here is guessed; the defaults come from Jesse&apos;s and Simona&apos;s calls, and change the moment you say so.
        </div>
      </div>

      {/* Service level dial */}
      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Service level</div>
      <div className="panel">
        <div style={{ fontSize: 14, color: "var(--ink2)", lineHeight: 1.6, marginBottom: 14 }}>
          The one dial that trades waste against selling out. Default is <b style={{ color: "var(--ink)" }}>Balanced</b>
          {balanced ? <> — {balanced.waste_pct}% waste at {balanced.lost_sales_pct}% lost sales.</> : <>.</>} Set it once for the network, or per store and product.
        </div>
        {scenarios.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Setting</th><th className="num">Waste</th><th className="num">Lost sales</th><th className="num">Loaves saved / wk</th></tr>
              </thead>
              <tbody>
                {scenarios.map((s) => (
                  <tr key={s.scenario} style={s.scenario === "balanced" ? { background: "rgba(255,199,44,0.10)" } : undefined}>
                    <td className="strong">{s.label}{s.scenario === "balanced" ? " · default" : ""}</td>
                    <td className="num">{s.waste_pct}%</td>
                    <td className="num">{s.lost_sales_pct ?? "—"}%</td>
                    <td className="num strong">{s.units_saved_wk.toLocaleString("en-AU")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Assumptions */}
      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Baking &amp; supply assumptions</div>
      <div className="panel" style={{ padding: 0 }}>
        {assumptions.map((a, i) => (
          <div key={a.label} style={{ display: "flex", gap: 20, padding: "16px 20px", borderTop: i ? "1px solid var(--line)" : undefined, alignItems: "baseline" }}>
            <div style={{ width: 160, fontWeight: 600, flexShrink: 0 }}>{a.label}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: "var(--ink)" }}>{a.value}</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3, lineHeight: 1.5 }}>{a.note}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Buffer rules */}
      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Headroom by store type</div>
      <div className="panel">
        <div style={{ fontSize: 13.5, color: "var(--ink2)", lineHeight: 1.6, marginBottom: 14 }}>
          A little extra on top of forecast demand, so a good day doesn&apos;t sell out — more where a store is only reached every second day.
        </div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Store type</th><th className="num">Extra headroom</th></tr></thead>
            <tbody>
              {buffers.map((b) => (
                <tr key={b.type}><td className="strong">{b.type}</td><td className="num strong">{b.buffer}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Feed coverage */}
      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Feed coverage</div>
      <div className="panel">
        <div style={{ fontSize: 14, color: "var(--ink2)", lineHeight: 1.7 }}>
          <div><b style={{ color: "var(--green)" }}>● Woolworths</b> — mature feed, live on plan. Full per-store, per-product orders.</div>
          <div style={{ marginTop: 6 }}><b style={{ color: "var(--amber)" }}>● Coles &amp; Harris Farm</b> — feeds still filling in the ledger. They light up automatically as the sales data lands; nothing to configure.</div>
        </div>
      </div>

      <div className="foot" style={{ marginTop: 18 }}>
        Defaults shown are the current configuration. Store sizes, min/max, costs and the seasonal calendar are confirmed with Simona and flow straight in — no re-build needed.
      </div>
    </>
  );
}
