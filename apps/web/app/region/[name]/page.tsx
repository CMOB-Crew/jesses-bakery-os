import Link from "next/link";
import { notFound } from "next/navigation";
import { getRegionStores } from "@/lib/queries";
import StoresList from "@/components/StoresList";

// Render per request, consistent with the other data pages and off the
// build-time prerender path.
export const dynamic = "force-dynamic";

export default async function RegionPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const region = decodeURIComponent(name);
  const stores = await getRegionStores(region);
  if (!stores.length) notFound();

  // A store is only scored where we can actually see its sales — otherwise it is
  // awaiting feed, not "on track". Identical rule to the Overview and the Stores
  // list, and it has to stay identical: a sent-or-sold test alone lets a dark
  // store through, because it is still being delivered to, and with a NULL waste
  // (migration 027) jb_status has nothing to fail it on and returns green.
  const hasData = (s: (typeof stores)[number]) =>
    s.has_sales_feed !== false && (Number(s.total_sent) > 0 || Number(s.total_sold) > 0);
  const red = stores.filter((s) => hasData(s) && s.status === "red").length;
  const amber = stores.filter((s) => hasData(s) && s.status === "amber").length;
  const green = stores.filter((s) => hasData(s) && s.status === "green").length;
  const nodata = stores.filter((s) => !hasData(s)).length;
  // Waste is measured over the reporting stores ONLY, and both halves of the
  // fraction have to come from the same set. total_wasted is NULL for a store
  // with no feed, so it contributes nothing to the numerator — but its
  // total_sent is real and lands in the denominator regardless. Summing across
  // every store therefore divides the waste of the few by the deliveries of the
  // many and prints a number that is too low by exactly the size of the dark
  // half of the region. Same bug as the Overview headline (migration 031) and
  // the Products tiles.
  const measured = stores.filter(hasData);
  const sent = measured.reduce((a, s) => a + Number(s.total_sent), 0);
  const wasted = measured.reduce((a, s) => a + Number(s.total_wasted), 0);
  const waste = sent ? Math.round((1000 * wasted) / sent) / 10 : null;

  return (
    <>
      <div className="crumbs"><Link href="/">Overview</Link> › {region}</div>
      <div className="panel">
        <div className="sh-top">
          <h3>{region}</h3>
          <span className="sh-meta">
            {stores.length} stores · {waste == null ? "no sales feed yet, so no waste figure" : `waste ${waste}% across the ${measured.length} we can see`}
          </span>
        </div>
        <div style={{ fontSize: 14, color: "var(--ink2)" }}>
          {red} {red === 1 ? "store needs" : "stores need"} attention · {amber} to watch · {green} on track{nodata ? ` · ${nodata} awaiting feed` : ""}.
        </div>
      </div>

      <div className="section-h" style={{ marginBottom: 12 }}><span className="tick" />Stores in {region}</div>
      <StoresList stores={stores} showRegion={false} />
    </>
  );
}
