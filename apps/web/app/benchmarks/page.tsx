import { getBenchmarks } from "@/lib/queries";
import StoreBenchmarks from "@/components/StoreBenchmarks";

export const metadata = { title: "Benchmarks · Jesse's Bakery OS" };
export const revalidate = 120;

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
