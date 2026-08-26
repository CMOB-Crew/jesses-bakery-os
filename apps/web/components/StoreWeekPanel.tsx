"use client";

import { useMemo, useState } from "react";
import type { StoreDay, StoreSellout, StoreSchedule, RunPick } from "@/lib/queries";
import StoreDeliveryPanel from "@/components/StoreDeliveryPanel";

/* ------------------------------------------------------------------ *
 * The week for one store, day by day — built to Simona's 26 Aug brief.
 *
 * Three of her asks live here, and they are one thing rather than three:
 *
 *   "I need to see it by day."  Weekdays are quiet and weekends are heavy, so a
 *   weekly total tells her nothing about where to adjust. Mon to Sun, always
 *   seven columns, including the days that are zero — a missing day and a zero
 *   day mean different things and she has to be able to tell them apart.
 *
 *   "I've never, ever been able to see where we've sold out of stock."  The old
 *   copy said "sold out on 7 days" with no product and no day. A count is not
 *   actionable. "Wholemeal sourdough, Friday" is: she sends more wholemeal on
 *   Fridays. So the sellouts are listed per line, per day, with what was
 *   delivered against what sold.
 *
 *   "What run it's on and what days it goes out."  Right-hand half — now
 *   StoreDeliveryPanel, which owns that whole ask (all seven days, each naming
 *   its run on the face, one Edit button, and the multiple-runs flag inside the
 *   box). She named three override stores from memory (Maroubra, Kings Cross,
 *   Eastgardens) and for those the base run is wrong most of the week.
 *
 * Deliberately no running totals — she asked for the daily figures precisely
 * because the totals were hiding the shape.
 * ------------------------------------------------------------------ */

const nf = (n: number) => (Number(n) || 0).toLocaleString("en-AU");
const DAY_FULL: Record<string, string> = {
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
};
const titleCase = (t: string) =>
  (t || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export default function StoreWeekPanel({
  days,
  sellouts,
  schedule,
  storeId,
  runs = [],
}: {
  days: StoreDay[];
  sellouts: StoreSellout[];
  schedule: StoreSchedule | null;
  storeId: string;
  runs?: RunPick[];
}) {
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, StoreSellout[]>();
    for (const s of sellouts) {
      const arr = m.get(s.day) ?? [];
      arr.push(s);
      m.set(s.day, arr);
    }
    return m;
  }, [sellouts]);

  // Scale the bars against the busiest day, not against a fixed ceiling — the
  // point is the shape of the week, and a quiet store's shape matters as much
  // as a busy one's.
  const peak = Math.max(1, ...days.map((d) => Math.max(d.delivered, d.sold)));
  const totalOut = sellouts.length;
  const daysOut = byDay.size;

  // No daily figures does NOT mean no delivery days. The stores with no sales
  // feed are the invoice customers — cafes, schools, JESSE'S CAFE — and they
  // still go out on a van on set days. An early return here would hide the
  // delivery panel from exactly the stores whose only schedule lives in it.
  const noFigures = !days.length;

  return (
    <div className="swp">
      <div className="swp-grid">
        {/* LEFT — the seven days */}
        <div className="panel swp-left">
          <div className="swp-h">
            Daily units this week
            <span>delivered vs sold · no running totals</span>
          </div>

          {noFigures ? (
            <div className="swp-empty">
              No daily figures for this store yet — they appear once its sales
              feed reports.
            </div>
          ) : (
          <>

          <div className="swp-days">
            {days.map((d) => {
              const outs = byDay.get(d.day) ?? [];
              const isOpen = openDay === d.day;
              return (
                <button
                  type="button"
                  key={d.day}
                  className={`swp-day${outs.length ? " hasout" : ""}${isOpen ? " open" : ""}`}
                  onClick={() => setOpenDay(isOpen ? null : d.day)}
                  aria-expanded={isOpen}
                  title={outs.length ? `${outs.length} line${outs.length === 1 ? "" : "s"} sold out — click for detail` : undefined}
                >
                  <span className="dow">{d.dow}</span>
                  <span className="bars">
                    <i className="bar del" style={{ height: `${(d.delivered / peak) * 100}%` }} />
                    <i className="bar sold" style={{ height: `${(d.sold / peak) * 100}%` }} />
                  </span>
                  <span className="nums">
                    <b>{nf(d.delivered)}</b>
                    <em>{nf(d.sold)}</em>
                  </span>
                  {outs.length > 0 && <span className="outdot">{outs.length}</span>}
                </button>
              );
            })}
          </div>

          <div className="swp-leg">
            <span><i className="sw del" />Delivered</span>
            <span><i className="sw sold" />Sold</span>
            {totalOut > 0 && <span><i className="sw out" />Ran out</span>}
          </div>

          {/* SOLD OUT — the thing she has never been able to see */}
          <div className="swp-out">
            {totalOut === 0 ? (
              <div className="oz">Nothing ran out this week.</div>
            ) : (
              <>
                <div className="oh">
                  Ran out on <b>{daysOut}</b> {daysOut === 1 ? "day" : "days"} ·{" "}
                  <b>{totalOut}</b> {totalOut === 1 ? "line" : "lines"}
                  {openDay && <button type="button" className="oclr" onClick={() => setOpenDay(null)}>show all days</button>}
                </div>
                <ul className="olist">
                  {(openDay ? sellouts.filter((s) => s.day === openDay) : sellouts).map((s, i) => (
                    <li key={`${s.day}-${s.product_id}-${i}`}>
                      <span className="od">{DAY_FULL[s.dow] ?? s.dow}</span>
                      <span className="op">{titleCase(s.product_name)}</span>
                      <span className="oq">
                        {nf(s.delivered)} sent · {nf(s.sold)} sold · <b>0 left</b>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          </>
          )}
        </div>

        {/* RIGHT — every day of the week, the run it goes out on, one Edit */}
        <StoreDeliveryPanel storeId={storeId} schedule={schedule} runs={runs} />
      </div>

      <style>{`
        .swp{display:block;margin-bottom:22px}
        .swp .swp-grid{display:grid;grid-template-columns:1fr 340px;gap:14px;align-items:start}
        .swp .panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .swp .swp-h{font-size:13px;font-weight:700;letter-spacing:.02em;margin-bottom:14px;display:flex;align-items:baseline;gap:10px}
        .swp .swp-h span{font-weight:400;font-size:11.5px;color:var(--muted);letter-spacing:0}

        .swp .swp-days{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
        .swp .swp-day{position:relative;background:transparent;border:1px solid var(--line2);border-radius:10px;padding:8px 4px 6px;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;font:inherit;transition:border-color .12s,background .12s}
        .swp .swp-day:hover{border-color:var(--line);background:var(--bg2,rgba(0,0,0,.015))}
        .swp .swp-day.open{border-color:var(--crust);background:var(--crust-b,rgba(201,138,52,.07))}
        .swp .swp-day .dow{font-size:11.5px;color:var(--muted);font-weight:600}
        .swp .swp-day .bars{display:flex;align-items:flex-end;gap:3px;height:56px}
        .swp .swp-day .bar{display:block;width:9px;border-radius:2px 2px 0 0;min-height:2px}
        .swp .swp-day .bar.del{background:#e7ddca}
        .swp .swp-day .bar.sold{background:#2a2019}
        .swp .swp-day .nums{display:flex;flex-direction:column;align-items:center;line-height:1.25;font-variant-numeric:tabular-nums}
        .swp .swp-day .nums b{font-size:12.5px;font-weight:600;color:var(--ink2)}
        .swp .swp-day .nums em{font-size:12.5px;font-style:normal;font-weight:700}
        .swp .swp-day .outdot{position:absolute;top:-7px;right:-7px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--red,#b4432e);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}

        .swp .swp-leg{display:flex;gap:16px;margin-top:12px;font-size:11.5px;color:var(--muted)}
        .swp .swp-leg .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
        .swp .swp-leg .sw.del{background:#e7ddca} .swp .swp-leg .sw.sold{background:#2a2019}
        .swp .swp-leg .sw.out{background:var(--red,#b4432e);border-radius:999px}

        .swp .swp-out{margin-top:16px;border-top:1px solid var(--line2);padding-top:14px}
        .swp .oz{font-size:13px;color:var(--ink2)}
        .swp .oh{font-size:13px;color:var(--ink2);margin-bottom:10px}
        .swp .oclr{margin-left:10px;background:none;border:none;padding:0;font:inherit;font-size:12px;color:var(--crust-deep);text-decoration:underline;cursor:pointer}
        .swp .olist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:210px;overflow-y:auto}
        .swp .olist li{display:grid;grid-template-columns:88px 1fr auto;gap:12px;align-items:baseline;font-size:13px;padding:5px 8px;border-radius:7px;background:var(--bg2,rgba(0,0,0,.02))}
        .swp .olist .od{color:var(--muted);font-size:12px;font-weight:600}
        .swp .olist .op{font-weight:600}
        .swp .olist .oq{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}

        .swp .swp-empty{padding:26px 4px;text-align:center;color:var(--ink2);font-size:13.5px}

        @media (max-width:1080px){ .swp .swp-grid{grid-template-columns:1fr} }
      `}</style>
    </div>
  );
}
