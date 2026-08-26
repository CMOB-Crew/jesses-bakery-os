"use client";

import { useMemo, useState } from "react";
import type { StoreDay, StoreSellout, StoreSchedule } from "@/lib/queries";

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
 *   "What run it's on and what days it goes out."  Right-hand half. Per-day
 *   overrides are shown next to the base run because she named three from
 *   memory (Maroubra, Kings Cross, Eastgardens) and for those stores the base
 *   run is wrong most of the week.
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
}: {
  days: StoreDay[];
  sellouts: StoreSellout[];
  schedule: StoreSchedule | null;
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

  if (!days.length) {
    return (
      <div className="swp">
        <div className="swp-empty">
          No daily figures for this store yet — they appear once its sales feed
          reports.
        </div>
        <style>{`.swp .swp-empty{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px 20px;text-align:center;color:var(--ink2);font-size:14px}`}</style>
      </div>
    );
  }

  return (
    <div className="swp">
      <div className="swp-grid">
        {/* LEFT — the seven days */}
        <div className="panel swp-left">
          <div className="swp-h">
            Daily units this week
            <span>delivered vs sold · no running totals</span>
          </div>

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
        </div>

        {/* RIGHT — run and delivery days */}
        <div className="panel swp-right">
          <div className="swp-h">Run &amp; delivery days</div>
          {schedule ? (
            <>
              <div className="sr-run">{schedule.run_name ?? "No run set"}</div>
              <div className="sr-days">
                {(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((d) => {
                  const on = schedule.delivery_days.includes(d);
                  const ov = schedule.overrides.find((o) => o.day === d);
                  return (
                    <span key={d} className={`sr-d${on ? " on" : ""}${ov ? " ov" : ""}`} title={ov ? `Runs with ${ov.run} on ${DAY_FULL[titleCase(d)] ?? d}` : undefined}>
                      {titleCase(d)}
                    </span>
                  );
                })}
              </div>
              <div className="sr-n">
                {schedule.delivery_days.length === 0
                  ? "No delivery days set for this store."
                  : `${schedule.delivery_days.length} ${schedule.delivery_days.length === 1 ? "delivery" : "deliveries"} a week.`}
              </div>
              {schedule.overrides.length > 0 && (
                <div className="sr-ov">
                  <div className="sr-ovh">Runs with a different team on:</div>
                  {schedule.overrides.map((o) => (
                    <div className="sr-ovr" key={o.day}>
                      <span>{DAY_FULL[titleCase(o.day)] ?? titleCase(o.day)}</span>
                      <b>{o.run}</b>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="sr-n">No schedule on file for this store.</div>
          )}
        </div>
      </div>

      <style>{`
        .swp{display:block;margin-bottom:22px}
        .swp .swp-grid{display:grid;grid-template-columns:1fr 300px;gap:14px;align-items:start}
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

        .swp .sr-run{font-family:var(--serif);font-size:20px;font-weight:600;letter-spacing:-.3px}
        .swp .sr-days{display:flex;gap:4px;margin-top:12px;flex-wrap:wrap}
        .swp .sr-d{font-size:11px;font-weight:700;padding:4px 7px;border-radius:6px;background:var(--bg2,rgba(0,0,0,.04));color:var(--muted)}
        .swp .sr-d.on{background:var(--crust,#c98a34);color:#fff}
        .swp .sr-d.ov{outline:2px solid var(--amber,#c8912a);outline-offset:1px}
        .swp .sr-n{font-size:12px;color:var(--muted);margin-top:10px;line-height:1.5}
        .swp .sr-ov{margin-top:14px;border-top:1px solid var(--line2);padding-top:12px}
        .swp .sr-ovh{font-size:11.5px;color:var(--muted);margin-bottom:7px}
        .swp .sr-ovr{display:flex;justify-content:space-between;font-size:12.5px;padding:3px 0}
        .swp .sr-ovr b{font-weight:700}

        @media (max-width:1080px){ .swp .swp-grid{grid-template-columns:1fr} }
      `}</style>
    </div>
  );
}
