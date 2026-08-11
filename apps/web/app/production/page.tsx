import { getProductionPlan, type ProductionLine } from "@/lib/queries";

export const metadata = { title: "Production · Jesse's Bakery OS" };
export const revalidate = 120; // cache ~2 min

const titleCase = (t: string) => t.replace(/\b\w/g, (c) => c.toUpperCase());

export default async function ProductionPage() {
  const lines = await getProductionPlan();

  if (!lines.length) {
    return (
      <>
        <div className="head"><h1>Production</h1></div>
        <div className="panel">
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Bake plan is warming up</div>
          <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>
            The bake plan totals the engine&apos;s per-store orders into a factory sheet — how much of each product to make.
            It lights up here as the plan is written on the mature Woolworths feed.
          </div>
        </div>
      </>
    );
  }

  const totalSent = lines.reduce((a, l) => a + l.sent, 0);
  const totalRec = lines.reduce((a, l) => a + l.recommended, 0);
  const trim = totalSent - totalRec;

  // group by category, biggest bake first
  const byCat = new Map<string, ProductionLine[]>();
  for (const l of lines) {
    const k = titleCase(l.category || "other");
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push(l);
  }
  const cats = [...byCat.entries()]
    .map(([category, ls]) => ({
      category,
      ls,
      sent: ls.reduce((a, l) => a + l.sent, 0),
      rec: ls.reduce((a, l) => a + l.recommended, 0),
    }))
    .sort((a, b) => b.sent - a.sent);

  return (
    <>
      <div className="head">
        <h1>Production</h1>
        <div className="meta">This week&apos;s bake plan · engine-sized · {lines.length} lines</div>
      </div>

      <div className="panel">
        <div style={{ fontSize: 15, lineHeight: 1.6 }}>
          Across the stores on plan you&apos;re baking <b>{totalSent.toLocaleString("en-AU")}</b> units this week; sized to real demand the engine
          makes <b>{totalRec.toLocaleString("en-AU")}</b>
          {trim > 0 ? (
            <> — <b style={{ color: "var(--green)" }}>{trim.toLocaleString("en-AU")} fewer</b>, so far less comes back at end of day.</>
          ) : (
            <>.</>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 10 }}>
          Mature Woolworths feed. Totals the per-store orders into what the factory actually needs to make.
        </div>
      </div>

      {cats.map((c) => {
        const cTrim = c.sent - c.rec;
        return (
          <div key={c.category} style={{ marginTop: 22 }}>
            <div className="section-h" style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span><span className="tick" />{c.category}</span>
              <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>
                {c.sent.toLocaleString("en-AU")} → {c.rec.toLocaleString("en-AU")}
                {cTrim > 0 ? <span style={{ color: "var(--green)" }}> · {cTrim.toLocaleString("en-AU")} fewer</span> : null}
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Product</th><th className="num">Baking now</th><th className="num">Engine plan</th><th className="num">Change</th><th className="num">Stores</th></tr>
                </thead>
                <tbody>
                  {c.ls.sort((a, b) => b.sent - a.sent).map((l) => {
                    const d = l.sent - l.recommended;
                    return (
                      <tr key={l.name}>
                        <td className="strong">{l.name}</td>
                        <td className="num">{l.sent.toLocaleString("en-AU")}</td>
                        <td className="num strong">{l.recommended.toLocaleString("en-AU")}</td>
                        <td className="num" style={{ color: d > 0 ? "var(--green)" : d < 0 ? "var(--amber)" : "var(--muted)", fontWeight: 600 }}>
                          {d > 0 ? `−${d}` : d < 0 ? `+${-d}` : "—"}
                        </td>
                        <td className="num" style={{ color: "var(--muted)" }}>{l.stores}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}
