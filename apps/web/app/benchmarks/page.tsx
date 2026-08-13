import StoreBenchmarks from "@/components/StoreBenchmarks";

export const metadata = { title: "Benchmarks · Jesse's Bakery OS" };

export default function BenchmarksPage() {
  return (
    <>
      <div className="head">
        <h1>Benchmarks</h1>
        <div className="meta">Every store judged against its peers, not one target</div>
      </div>
      <StoreBenchmarks />
    </>
  );
}
