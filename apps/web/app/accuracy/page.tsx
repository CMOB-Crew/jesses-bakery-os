import { getForecastAccuracy } from "@/lib/queries";
import ForecastAccuracy from "@/components/ForecastAccuracy";

export const metadata = { title: "Forecast accuracy · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";

export default async function AccuracyPage() {
  const data = await getForecastAccuracy();
  return (
    <>
      <div className="head">
        <h1>Forecast accuracy</h1>
        <div className="meta">Is the plan getting it right?</div>
      </div>
      <ForecastAccuracy data={data} />
    </>
  );
}
