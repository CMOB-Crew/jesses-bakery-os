import DriverApp from "@/components/DriverApp";

export const metadata = { title: "Driver · Jesse's Bakery OS" };

export default function DriverPage() {
  return (
    <>
      <div className="head"><h1>Driver app</h1><div className="meta">Phone prototype · what the driver taps through on the run</div></div>
      <DriverApp />
    </>
  );
}
