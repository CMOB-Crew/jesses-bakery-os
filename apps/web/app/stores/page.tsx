import Link from "next/link";
import { getStoreWeek } from "@/lib/queries";
import StatusTag from "@/components/StatusTag";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

const order = { red: 0, amber: 1, green: 2 } as const;

export default async function StoresPage() {
  const stores = (await getStoreWeek()).sort(
    (a, b) => order[a.status] - order[b.status] || b.total_wasted - a.total_wasted
  );
  return (
    <>
      <div className="head"><h1>Stores</h1><div className="meta">{stores.length} active · worst first</div></div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Store</th><th>Region</th><th>Status</th><th className="num">Waste %</th><th className="num">Stockouts</th><th className="num">Sold (wk)</th></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.store_id} className="clk">
                <td className="strong"><Link href={`/store/${s.store_id}`}>{s.name}</Link></td>
                <td style={{ color: "var(--ink2)" }}>{s.region}</td>
                <td><StatusTag status={s.status} /></td>
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
