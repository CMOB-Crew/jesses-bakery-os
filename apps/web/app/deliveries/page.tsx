import Link from "next/link";
import { getDeliveryPlan, type DeliveryLine } from "@/lib/queries";

export const metadata = { title: "Deliveries · Jesse's Bakery OS" };
export const revalidate = 120; // cache ~2 min

export default async function DeliveriesPage() {
  const lines = await getDeliveryPlan();

  // Empty until the engine plan is loaded — keep it honest, don't show a blank grid.
  if (!lines.length) {
    return (
      <>
        <div className="head"><h1>Deliveries</h1></div>
        <div className="panel">
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Order sheet is warming up</div>
          <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>
            The delivery order sheet is generated from the plan on the mature Woolworths feed.
            It lights up here store-by-store as the plan is written.
          </div>
        </div>
      </>
    );
  }

  const totalSent = lines.reduce((a, l) => a + l.sent, 0);
  const totalRec = lines.reduce((a, l) => a + l.recommended, 0);
  const trim = totalSent - totalRec;

  // group by region, worst over-supply first
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
      rec: ls.reduce((a, l) => a + l.recommended, 0),
    }))
    .sort((a, b) => (b.sent - b.rec) - (a.sent - a.rec));

  return (
    <>
      <div className="head">
        <h1>Deliveries</h1>
        <div className="meta">This week&apos;s delivery plan · {lines.length} stores on plan</div>
      </div>

      <div className="panel">
        <div style={{ fontSize: 15, lineHeight: 1.6 }}>
          Across the stores on plan, you&apos;re sending <b>{totalSent.toLocaleString("en-AU")}</b> units this week; sized to what actually sells, the plan sends{" "}
          <b>{totalRec.toLocaleString("en-AU")}</b>
          {trim > 0 ? (
            <> — <b style={{ color: "var(--green)" }}>{trim.toLocaleString("en-AU")} less</b>, sized to real demand.</>
          ) : (
            <>.</>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 10 }}>
          Mature Woolworths feed. Final delivery is the number that actually goes out to each store. Green trims over-supply (less waste); amber adds cover where a store ran short. Tap a store for its line-by-line order.
        </div>
      </div>

      {regions.map((r) => {
        const rTrim = r.sent - r.rec;
        return (
          <div key={r.region} style={{ marginTop: 22 }}>
            <div className="section-h" style={{ marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span><span className="tick" />{r.region}</span>
              <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>
                {r.sent.toLocaleString("en-AU")} → {r.rec.toLocaleString("en-AU")}
                {rTrim > 0 ? <span style={{ color: "var(--green)" }}> · {rTrim.toLocaleString("en-AU")} less</span> : null}
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>Store</th><th className="num">Sending now</th><th className="num">Final delivery</th><th className="num">Change</th></tr>
                </thead>
                <tbody>
                  {r.ls.sort((a, b) => (b.sent - b.recommended) - (a.sent - a.recommended)).map((l) => {
                    const d = l.sent - l.recommended;
                    return (
                      <tr key={l.store_id} className="clk">
                        <td className="strong"><Link href={`/store/${l.store_id}`}>{l.name}</Link></td>
                        <td className="num">{l.sent}</td>
                        <td className="num strong">{l.recommended}</td>
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
    </>
  );
}
