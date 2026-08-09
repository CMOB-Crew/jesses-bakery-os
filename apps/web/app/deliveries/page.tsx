export const metadata = { title: "Deliveries · Jesse's Bakery OS" };
export default function Page() {
  return (
    <>
      <div className="head"><h1>Deliveries</h1></div>
      <div className="panel">
        <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Coming in the next build phase</div>
        <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>
          The deliveries workspace is scaffolded and wired into the same live data layer as the Overview.
          It lights up as we build Phase 2 (accountability &amp; logistics) on top of the foundation that&apos;s now running.
        </div>
      </div>
    </>
  );
}
