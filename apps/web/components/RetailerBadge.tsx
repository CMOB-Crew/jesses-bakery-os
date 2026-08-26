// Retailer marker for store rows and profiles.
//
// Simona asked to see the retailer at a glance rather than reading the word
// (Session 2 UAT). The first version was a brand-COLOURED monogram — a green W,
// a red C, a green H — which was a placeholder, and Javonte called it out: the
// point of a brand mark is that you recognise it without reading it, and a
// letter in a box still has to be read.
//
// So these are now the marks themselves: Woolworths' W-and-leaf, Coles' and
// Harris Farm's wordmarks, each on its brand colour. Direct-invoice ("small
// shops") stay a neutral text chip — Simona said those don't need a mark.
//
// A note on what these are. They are hand-drawn SVG in the retailers' own
// colours and shapes, used to identify Jesse's actual customers inside Jesse's
// own system. They are close, not pixel-exact reproductions. If we ever want the
// official artwork, every retailer publishes it in their brand kit and swapping
// it in is a change to MARK below and nothing else — no caller changes.
//
// One self-contained component so every surface renders the marker the same.

type Brand = {
  label: string;
  /** Wordmark as it is set in the retailer's own logo. */
  word: string;
  bg: string;
  /** Lowercase, tighter tracking — Coles sets its name that way. */
  lower?: boolean;
  mark?: React.ReactNode;
};

const WOOLWORTHS_MARK = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {/* The W, one continuous rounded stroke, with the right arm running up into
        the leaf rather than stopping — that join is the whole mark. */}
    <path
      d="M2.6 6.4 L6.2 17.0 C6.6 18.3 8.4 18.4 8.9 17.1 L12 9.6 L15.1 17.1 C15.6 18.4 17.4 18.3 17.8 17.0 L18.8 14.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M18.3 14.9 C17.2 11.2 18.8 7.4 21.9 6.0 C22.9 9.6 21.4 13.4 18.3 14.9 Z"
      fill="currentColor"
    />
  </svg>
);

const HARRIS_FARM_MARK = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3.6 20.4 C3.6 10.4 10.4 3.6 20.4 3.6 C20.4 13.6 13.6 20.4 3.6 20.4 Z" fill="currentColor" />
    {/* Midrib, cut out in the brand green so the leaf reads as a leaf and not a
        blob. It is knocked through in the pill's own colour, which is why this
        mark is only ever drawn on that colour. */}
    <path d="M4.6 19.4 L16.4 7.6" fill="none" stroke="#1f6b3b" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const MARK: Record<string, Brand> = {
  woolworths: { label: "Woolworths", word: "Woolworths", bg: "#178841", mark: WOOLWORTHS_MARK },
  // Coles' logo is a wordmark — there is no separate symbol to show, so the
  // word IS the mark. Lowercase and tight, the way they set it.
  coles: { label: "Coles", word: "coles", bg: "#E01A22", lower: true },
  harris_farm: { label: "Harris Farm", word: "Harris Farm", bg: "#1f6b3b", mark: HARRIS_FARM_MARK },
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
  const b = MARK[retailer];
  if (!b) {
    // Invoice / independent — a plain neutral chip, no mark.
    const label = retailer ? retailer[0].toUpperCase() + retailer.slice(1) : "—";
    return <span className={`rbadge plain ${size}`}>{label}</span>;
  }

  // No room for the word (dense contexts): show the symbol alone. Coles has no
  // symbol, so it keeps its initial rather than showing nothing.
  if (!showLabel) {
    return (
      <span className={`rbadge tile ${size}`} style={{ background: b.bg }} title={b.label} aria-label={b.label}>
        {b.mark ?? <i className="rb-i">c</i>}
      </span>
    );
  }

  return (
    <span
      className={`rbadge logo ${size}${b.lower ? " lower" : ""}`}
      style={{ background: b.bg }}
      title={b.label}
      aria-label={b.label}
    >
      {b.mark}
      <span className="rb-w">{b.word}</span>
    </span>
  );
}
