import Link from "next/link";
import { notFound } from "next/navigation";
import { getRegionStores } from "@/lib/queries";
import StoresList from "@/components/StoresList";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

export default async function RegionPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const region = decodeURIComponent(name);
  const stores = await getRegionStores(region);
  if (!stores.length) notFound();

  const red = stores.filter((s) => s.status === "red").length;
  const amber = stores.filter((s) => s.status === "amber").length;
  const sent = stores.reduce((a, s) => a + Number(s.total_sent), 0);
  const wasted = stores.reduce((a, s) => a + Number(s.total_wasted), 0);
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

      <div className="section-h" style={{ marginBottom: 12 }}><span className="tick" />Stores in {region}</div>
      <StoresList stores={stores} showRegion={false} />
    </>
  );
}
