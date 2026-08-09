import Link from "next/link";
import { notFound } from "next/navigation";
import { getRegionStores } from "@/lib/queries";
import StatusTag from "@/components/StatusTag";

export const dynamic = "force-dynamic";

export default async function RegionPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const region = decodeURIComponent(name);
  const stores = await getRegionStores(region);
  if (!stores.length) notFound();

  const red = stores.filter((s) => s.status === "red").length;
  const amber = stores.filter((s) => s.status === "amber").length;
  const sent = stores.reduce((a, s) => a + s.total_sent, 0);
  const wasted = stores.reduce((a, s) => a + s.total_wasted, 0);
  const waste = sent ? Math.round((1000 * wasted) / sent) / 10 : 0;

  return (
    <>
      <div className="crumbs"><Link href="/">Overview</Link> › {region}</div>
      <div className="panel">
        <div className="sh-top">
          <h3>{region}</h3>
          <span className="sh-meta">{stores.length} stores · waste {waste}%</span>
        </div>
        <div style={{ fontSize: 14, color: "var(--ink2)" }}>
          {red} store{red !== 1 ? "s" : ""} need attention, {amber} to watch. The rest are on track.
        </div>
      </div>

      <div className="section-h" style={{ marginBottom: 12 }}><span className="tick" />Stores · worst first</div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Store</th><th>Status</th><th>Size</th><th className="num">Waste %</th><th className="num">Stockouts</th><th className="num">Sold (wk)</th></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.store_id} className="clk">
                <td className="strong"><Link href={`/store/${s.store_id}`}>{s.name}</Link></td>
                <td><StatusTag status={s.status} /></td>
                <td style={{ textTransform: "capitalize", color: "var(--ink2)" }}>{s.size_category}</td>
                <td className="num">{s.waste_pct}%</td>
                <td className="num">{s.stockout_days || "—"}</td>
                <td className="num">{s.total_sold.toLocaleString("en-AU")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
