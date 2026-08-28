import Image from "next/image";

// Retailer marker for store rows and profiles.
//
// Simona asked to see the retailer at a glance rather than reading the word
// (Session 2 UAT). The first version was a brand-COLOURED monogram, then
// hand-drawn SVG approximations of each mark. Both were placeholders and both
// were called out for the same reason: the point of a brand mark is that you
// recognise it without reading it.
//
// These are the real marks. The old file promised the swap would be "a change
// to MARK below and nothing else -- no caller changes", and it was.
//
//   Woolworths   the apple, beside the word -- the apple alone is the mark
//   Coles        the wordmark IS the logo, so it carries the name itself
//   Harris Farm  the lockup, same -- the words are part of the mark
//   Invoice      unchanged: a neutral text chip, no mark (Simona's call)
//
// The chip is WHITE now rather than the brand colour. A green apple cannot sit
// on a green pill, and three saturated blocks in a dense store list were
// louder than the data. White with a hairline border lets each mark carry its
// own colour, which is how they are meant to be used.
//
// The artwork is raster, prepared from supplied images. Every one of these
// retailers publishes vector marks in a brand kit; dropping those in is a
// change to LOGO below and nothing else.

type Brand = {
  label: string;
  src: string;
  /** Intrinsic size of the asset, so Next/Image reserves the right box. */
  w: number;
  h: number;
  /** True when the mark is a symbol only and still needs the name beside it. */
  needsWord?: boolean;
};

const LOGO: Record<string, Brand> = {
  woolworths:  { label: "Woolworths",  src: "/retailers/woolworths.png",  w: 30, h: 28, needsWord: true },
  coles:       { label: "Coles",       src: "/retailers/coles.png",       w: 87, h: 28 },
  harris_farm: { label: "Harris Farm", src: "/retailers/harris-farm.png", w: 93, h: 28 },
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
  const b = LOGO[retailer];
  if (!b) {
    // Invoice / independent -- a plain neutral chip, no mark.
    const label = retailer ? retailer[0].toUpperCase() + retailer.slice(1) : "\u2014";
    return <span className={`rbadge plain ${size}`}>{label}</span>;
  }

  // The mark alone, for dense contexts. Every retailer has one that reads at
  // this size, so unlike the drawn version there is no letter fallback.
  const mark = (
    <Image
      src={b.src}
      alt={b.label}
      width={b.w}
      height={b.h}
      className="rb-logo"
      unoptimized
      priority={false}
    />
  );

  if (!showLabel) {
    return (
      <span className={`rbadge rblogo bare ${size}`} title={b.label} aria-label={b.label}>
        {mark}
      </span>
    );
  }

  return (
    <span className={`rbadge rblogo ${size}`} title={b.label}>
      {mark}
      {/* Only Woolworths needs the name beside it. The other two marks say it. */}
      {b.needsWord && <span className="rb-w">{b.label}</span>}
    </span>
  );
}
