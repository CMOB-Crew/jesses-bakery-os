import { getBenchmarks } from "@/lib/queries";
import StoreBenchmarks from "@/components/StoreBenchmarks";

export const metadata = { title: "Benchmarks · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export default async function BenchmarksPage() {
  const data = await getBenchmarks();
  return (
    <>
      <div className="head">
        <h1>Benchmarks</h1>
        <div className="meta">Every store judged against its peers, not one target</div>
      </div>
      <StoreBenchmarks data={data} />
    </>
  );
}
