// Retailer marker for store rows and profiles. Simona asked to see the retailer
// at a glance rather than reading the word (Session 2 UAT). These are brand-
// COLOURED monogram chips — a green W for Woolworths, a red C for Coles, a green
// H for Harris Farm — not reproductions of the retailers' actual logos. Direct-
// invoice ("small shops") stay a neutral text chip; she said those don't need a
// mark. One self-contained component so every surface renders the marker the same.

const BRAND: Record<string, { label: string; bg: string; mono: string }> = {
  woolworths: { label: "Woolworths", bg: "#178841", mono: "W" },
  coles: { label: "Coles", bg: "#E01A22", mono: "C" },
  harris_farm: { label: "Harris Farm", bg: "#1f6b3b", mono: "H" },
};

export default function RetailerBadge({
  retailer,
  showLabel = true,
  size = "md",
}: {
  retailer: string;
  showLabel?: boolean;
  size?: "sm" | "md";
}) {
  const b = BRAND[retailer];
  if (!b) {
    // Invoice / independent — a plain neutral chip, no monogram.
    const label = retailer ? retailer[0].toUpperCase() + retailer.slice(1) : "—";
    return <span className={`rbadge plain ${size}`}>{label}</span>;
  }
  return (
    <span className={`rbadge ${size}`} title={b.label}>
      <i style={{ background: b.bg }} aria-hidden="true">{b.mono}</i>
      {showLabel && <span className="rbadge-l">{b.label}</span>}
    </span>
  );
}
