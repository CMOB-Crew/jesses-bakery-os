import NetworkMap from "@/components/NetworkMap";

export const metadata = { title: "Network map · Jesse's Bakery OS" };

export default function MapPage() {
  return (
    <>
      <div className="head">
        <h1>Network map</h1>
        <div className="meta">The whole network at a glance</div>
      </div>
      <NetworkMap />
    </>
  );
}
