import ForecastAccuracy from "@/components/ForecastAccuracy";

export const metadata = { title: "Forecast accuracy · Jesse's Bakery OS" };

export default function AccuracyPage() {
  return (
    <>
      <div className="head">
        <h1>Forecast accuracy</h1>
        <div className="meta">Is the engine getting it right?</div>
      </div>
      <ForecastAccuracy />
    </>
  );
}
