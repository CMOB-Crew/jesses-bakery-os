"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WeekdayShape, SeasonEvent } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Seasonality calendar — the events calendar the engine plans against.
 * Front-end to the `events` table (name, kind, state, start/end,
 * uplift_pct). Every factor Simona named is here and editable:
 * weekday shape, school holidays, public/long weekends, Jewish
 * calendar, weather. The weekday shape is now MEASURED from real
 * sell-through (Simona's "weekends run much higher"); events stay
 * seeded from her 12 Aug session so she can see and adjust them.
 * ------------------------------------------------------------------ */

// Fallback weekday shape, indexed by JS getDay() (0=Sun … 6=Sat).
// From Simona's verbal read (large store Mon–Wed ~80 → Thu–Sun ~120).
// Used only until there's a full week of real sales to measure from.
const SEED_BASE: number[] = [1.05, 0.8, 0.8, 0.85, 1.15, 1.25, 1.2];
const DOW_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Kind = "school" | "public" | "jewish" | "weather" | "retail" | "custom";

type Evt = {
  id: string;
  kind: Kind;
  name: string;
  scope: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD inclusive
  uplift: number; // network-blend % (matches events.uplift_pct)
  note: string;
};

// Seeded from the 12 Aug production session + Questions-for-Simona.
// Calendar dates verified 17 Aug against Hebcal (Jewish calendar) and the
// NSW school-term / public-holiday schedule.
const SEED: Evt[] = [
  { id: "rosh", kind: "jewish", name: "Rosh Hashanah", scope: "Large challah · ~6 Jewish-demographic stores",
    start: "2026-09-11", end: "2026-09-13", uplift: 12,
    note: "Large raisin / sesame / plain challah spike. Produce Wed 9–Thu 10 for the Friday lift. Network shown +12%; challah at those stores runs far higher." },
  { id: "yom", kind: "jewish", name: "Yom Kippur", scope: "Jewish-demographic stores",
    start: "2026-09-20", end: "2026-09-21", uplift: -8,
    note: "Fast day dips demand, then a break-fast bread/bagel lift the evening after. Confirm timing with Simona." },
  { id: "sukkot", kind: "jewish", name: "Sukkot → Simchat Torah", scope: "Challah · ~6 Jewish-demographic stores",
    start: "2026-09-25", end: "2026-10-04", uplift: 8,
    note: "Eight days of festive meals — a sustained challah lift at Jewish-demographic stores (Fri 25 Sep and Fri 2 Oct Shabbats are the peaks). Overlaps the spring school holidays, so at these stores challah rises while general supermarket bread falls — a clear per-store split." },
  { id: "sch-spring", kind: "school", name: "Spring school holidays", scope: "Network — coastal/holiday runs flip positive",
    start: "2026-09-28", end: "2026-10-09", uplift: -30,
    note: "Supermarket bread drops ~30% (straight to the bin on the legacy system). Exception: Central Coast & coastal runs INCREASE — this is per-store, not one number." },
  { id: "labour", kind: "public", name: "Labour Day (NSW)", scope: "Network · long weekend",
    start: "2026-10-05", end: "2026-10-05", uplift: 10,
    note: "Long-weekend lift; some runs shift a day — check delivery days that week." },
  { id: "heat", kind: "weather", name: "Forecast heatwave", scope: "Example — weather layer",
    start: "2026-09-18", end: "2026-09-19", uplift: -6,
    note: "Example only. Hot days soften bread. The weather layer stays off until a forecast feed is wired; Simona can add days by hand." },
  { id: "xmas", kind: "retail", name: "Christmas", scope: "Network",
    start: "2026-12-18", end: "2026-12-24", uplift: 40,
    note: "Biggest lift of the year, ~+40%. Ramp from mid-December." },
  { id: "easter", kind: "retail", name: "Easter", scope: "Network",
    start: "2027-04-02", end: "2027-04-05", uplift: 18,
    note: "Relevant lift around the long weekend. Confirm the basket with Simona." },
];

const KIND_META: Record<Kind, { label: string; c: string; b: string }> = {
  school:  { label: "School holidays", c: "#4f7396", b: "rgba(79,115,150,.14)" },
  public:  { label: "Public holiday",  c: "#b0741c", b: "rgba(176,116,28,.15)" },
  jewish:  { label: "Jewish calendar", c: "#8a5aa0", b: "rgba(138,90,160,.15)" },
  weather: { label: "Weather",         c: "#3f8f86", b: "rgba(63,143,134,.15)" },
  retail:  { label: "Retail / seasonal", c: "#5f8f5a", b: "rgba(95,143,90,.15)" },
  custom:  { label: "Custom",          c: "#8a8071", b: "rgba(138,128,113,.15)" },
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export default function SeasonalityCalendar({ live, liveEvents = [] }: { live: WeekdayShape | null; liveEvents?: SeasonEvent[] }) {
  // Weekday shape: measured from real sell-through when we have it, else the seed.
  const BASE = live?.shape ?? SEED_BASE;
  // Event set: from the shared events table when it's seeded, else the built-in
  // seed. Normalise the DB kind to a known calendar category (fallback custom).
  const base: Evt[] = useMemo(
    () =>
      liveEvents.length
        ? liveEvents.map((e) => ({
            id: e.id,
            kind: (e.kind in KIND_META ? e.kind : "custom") as Kind,
            name: e.name, scope: e.scope, start: e.start, end: e.end, uplift: e.uplift, note: e.note,
          }))
        : SEED,
    [liveEvents],
  );
  // Default to Sept 2026 — the High-Holiday planning window Simona flagged.
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(8); // 0-indexed → September
  const [sel, setSel] = useState<string | null>("2026-09-11");
  const [today, setToday] = useState<string>(""); // set after mount (SSR-safe)
  const [uplifts, setUplifts] = useState<Record<string, number>>(
    () => Object.fromEntries(base.map((e) => [e.id, e.uplift]))
  );

  useEffect(() => {
    // Read "today" only after mount so server-render and hydration match
    // (new Date() at render time would differ between build and client).
    const n = new Date();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToday(ymd(n.getFullYear(), n.getMonth(), n.getDate()));
  }, []);

  const events = useMemo(() => base.map((e) => ({ ...e, uplift: uplifts[e.id] ?? e.uplift })), [base, uplifts]);

  function eventsOn(key: string) {
    return events.filter((e) => key >= e.start && key <= e.end);
  }
  function dayMult(dow: number, key: string) {
    let m = BASE[dow];
    for (const e of eventsOn(key)) m *= 1 + e.uplift / 100;
    return m;
  }
  function tint(m: number) {
    if (m >= 1.28) return "rgba(176,116,28,.24)";
    if (m >= 1.12) return "rgba(176,116,28,.12)";
    if (m > 0.96) return "transparent";
    if (m > 0.82) return "rgba(79,115,150,.10)";
    return "rgba(79,115,150,.20)";
  }

  // Build a 6-week grid starting Monday.
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0
  const daysIn = new Date(year, month + 1, 0).getDate();
  const cells: { d: number; inMonth: boolean; y: number; m: number }[] = [];
  for (let i = 0; i < lead; i++) {
    const d = new Date(year, month, 1 - (lead - i));
    cells.push({ d: d.getDate(), inMonth: false, y: d.getFullYear(), m: d.getMonth() });
  }
  for (let d = 1; d <= daysIn; d++) cells.push({ d, inMonth: true, y: year, m: month });
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const idx = cells.length - (lead + daysIn) + 1;
    const d = new Date(year, month + 1, idx);
    cells.push({ d: d.getDate(), inMonth: false, y: d.getFullYear(), m: d.getMonth() });
    if (cells.length >= 42) break;
  }

  const monthEvents = events
    .filter((e) => e.start <= ymd(year, month, daysIn) && e.end >= ymd(year, month, 1))
    .sort((a, b) => a.start.localeCompare(b.start));

  function shift(delta: number) {
    let m = month + delta;
    let y = year;
    while (m < 0) { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    setMonth(m); setYear(y); setSel(null);
  }
  function goToday() {
    const n = new Date();
    setYear(n.getFullYear()); setMonth(n.getMonth());
    setSel(ymd(n.getFullYear(), n.getMonth(), n.getDate()));
  }

  // Selected-day breakdown
  const selDate = sel ? new Date(sel + "T00:00:00") : null;
  const selDow = selDate ? selDate.getDay() : null;
  const selEvents = sel ? eventsOn(sel) : [];
  const selMult = sel && selDow !== null ? dayMult(selDow, sel) : null;

  function bump(id: string, dir: number) {
    setUplifts((u) => ({ ...u, [id]: (u[id] ?? 0) + dir }));
  }

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }

  const fmtPct = (m: number) => {
    const p = Math.round((m - 1) * 100);
    return (p > 0 ? "+" : "") + p + "%";
  };

  return (
    <div className="seasn">
      <div className="panel intro">
        <div className="itxt">
          This is the events calendar the engine plans against — the same table the forecast reads. It starts from the
          <b> weekday shape</b> and layers the swings Simona named: school holidays, public and long weekends, the
          Jewish calendar, and weather. <b>Nothing here is fixed</b> — every uplift is a lever, and she can add a custom
          event for any store or region.
          {live ? (
            <> The weekday shape below is <b>measured from real sell-through</b> — weekends run <b>{live.weekendLift > 0 ? "+" : ""}{live.weekendLift}%</b> above
            the weekday average across {live.weeks} week{live.weeks === 1 ? "" : "s"} of data, exactly the factor Simona flagged.</>
          ) : (
            <> The weekday shape is Simona&apos;s verbal read for now; it switches to the measured shape once a full week of sales lands.</>
          )}
        </div>
      </div>

      <div className="ctrls">
        <div className="mnav">
          <button className="ico" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <div className="mlabel">{MONTHS[month]} {year}</div>
          <button className="ico" onClick={() => shift(1)} aria-label="Next month">›</button>
          <button className="todaybtn" onClick={goToday}>Today</button>
        </div>
        <div className="legend">
          {(Object.keys(KIND_META) as Kind[]).map((k) => (
            <span className="lg" key={k}><i style={{ background: KIND_META[k].c }} />{KIND_META[k].label}</span>
          ))}
        </div>
      </div>

      <div className="grid2">
        {/* Calendar */}
        <div className="cal">
          <div className="dowhead">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="cells">
            {cells.map((c, i) => {
              const key = ymd(c.y, c.m, c.d);
              const dt = new Date(c.y, c.m, c.d);
              const dow = dt.getDay();
              const evs = c.inMonth ? eventsOn(key) : [];
              const m = dayMult(dow, key);
              const isSel = sel === key && c.inMonth;
              const isToday = today === key && c.inMonth;
              return (
                <button
                  key={i}
                  className={`cell${c.inMonth ? "" : " out"}${isSel ? " sel" : ""}`}
                  style={{ background: c.inMonth ? tint(m) : undefined }}
                  onClick={() => c.inMonth && setSel(key)}
                  disabled={!c.inMonth}
                >
                  <div className="cdate">
                    <span className={isToday ? "todayn" : ""}>{c.d}</span>
                    {c.inMonth && <span className={`cmult${m >= 1.12 ? " up" : m <= 0.9 ? " dn" : ""}`}>×{m.toFixed(2)}</span>}
                  </div>
                  {c.inMonth && (
                    <div className="cevs">
                      {evs.slice(0, 2).map((e) => (
                        <span className="cev" key={e.id} style={{ background: KIND_META[e.kind].b, color: KIND_META[e.kind].c }}>
                          {e.name}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right rail */}
        <div className="rail">
          <div className="panel daycard">
            {sel && selDow !== null && selMult !== null ? (
              <>
                <div className="dc-h">{DOW_LABEL[selDow]} {selDate!.getDate()} {MONTHS[month]}</div>
                <div className="dc-big">×{selMult.toFixed(2)}<span className="dc-u">{fmtPct(selMult)} vs a flat day</span></div>
                <div className="dc-rows">
                  <div className="dcr">
                    <span className="dcr-l">Weekday shape · {DOW_LABEL[selDow]}</span>
                    <span className={`dcr-v${BASE[selDow] >= 1.05 ? " up" : BASE[selDow] <= 0.9 ? " dn" : ""}`}>{fmtPct(BASE[selDow])}</span>
                  </div>
                  {selEvents.map((e) => (
                    <div className="dcr" key={e.id}>
                      <span className="dcr-l"><i className="kd" style={{ background: KIND_META[e.kind].c }} />{e.name}</span>
                      <span className={`dcr-v${e.uplift > 0 ? " up" : " dn"}`}>{e.uplift > 0 ? "+" : ""}{e.uplift}%</span>
                    </div>
                  ))}
                  {selEvents.length === 0 && <div className="dc-none">Just the weekday shape — no events layered on this day.</div>}
                </div>
                <div className="dc-foot">
                  Engine plans this day <b>{fmtPct(selMult)}</b> against a flat week.
                  {selEvents.length > 0 && " Product-specific spikes (e.g. challah) run higher than the network figure."}
                </div>
              </>
            ) : (
              <div className="dc-empty">Pick a day to see how the engine sizes it.</div>
            )}
          </div>

          <div className="section-h" style={{ marginTop: 20, marginBottom: 10 }}><span className="tick" />Events this month</div>
          <div className="panel evlist" style={{ padding: 0 }}>
            {monthEvents.length === 0 && <div className="ev-none">No events in {MONTHS[month]} — just the weekday shape.</div>}
            {monthEvents.map((e, i) => (
              <div className="evrow" key={e.id} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}>
                <div className="ev-top">
                  <span className="ev-chip" style={{ background: KIND_META[e.kind].b, color: KIND_META[e.kind].c }}>{KIND_META[e.kind].label}</span>
                  <span className="ev-name">{e.name}</span>
                  <div className="ev-step">
                    <button onClick={() => bump(e.id, -1)} aria-label="Lower uplift">−</button>
                    <span className={`ev-up${e.uplift > 0 ? " up" : e.uplift < 0 ? " dn" : ""}`}>{e.uplift > 0 ? "+" : ""}{e.uplift}%</span>
                    <button onClick={() => bump(e.id, +1)} aria-label="Raise uplift">+</button>
                  </div>
                </div>
                <div className="ev-scope">{e.scope}</div>
                <div className="ev-note">{e.note}</div>
              </div>
            ))}
            <button className="addev" onClick={() => showToast("Adding events and per-store overrides is the next build phase — the calendar here reads from the shared events table.")}>+ Add event or store-specific override</button>
          </div>
          <div className="foot" style={{ marginTop: 12 }}>
            Seeded from Simona&apos;s 12 Aug session. Dates for the Jewish calendar are the engine&apos;s current
            assumption — confirmed with her. Nudging an uplift previews it live; writing changes back to the shared
            calendar is the next build phase.
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

      <style>{`
        .seasn .toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13.5px;font-weight:500;z-index:60;max-width:88vw;text-align:center}
        .seasn .intro{margin-bottom:16px}
        .seasn .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .seasn .intro b{color:var(--ink);font-weight:600}
        .seasn .ctrls{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:14px}
        .seasn .mnav{display:flex;align-items:center;gap:8px}
        .seasn .ico{width:32px;height:32px;border:1px solid var(--line);background:var(--card);border-radius:9px;font-size:18px;line-height:1;cursor:pointer;color:var(--ink);font-family:inherit}
        .seasn .ico:hover{background:#f6f0e6}
        .seasn .mlabel{font-family:var(--serif);font-size:20px;font-weight:600;min-width:168px;text-align:center;letter-spacing:-.3px}
        .seasn .todaybtn{margin-left:6px;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit}
        .seasn .todaybtn:hover{background:#f3ecdd}
        .seasn .legend{display:flex;gap:14px;flex-wrap:wrap;margin-left:auto}
        .seasn .lg{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2)}
        .seasn .lg i{width:10px;height:10px;border-radius:3px;display:inline-block}

        .seasn .grid2{display:grid;grid-template-columns:1.9fr 1fr;gap:18px;align-items:start}
        .seasn .cal{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
        .seasn .dowhead{display:grid;grid-template-columns:repeat(7,1fr);border-bottom:1px solid var(--line)}
        .seasn .dowhead div{padding:10px 8px;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;text-align:left}
        .seasn .cells{display:grid;grid-template-columns:repeat(7,1fr)}
        .seasn .cell{position:relative;min-height:92px;border-right:1px solid var(--line2);border-bottom:1px solid var(--line2);padding:7px 8px;text-align:left;cursor:pointer;font-family:inherit;background:transparent;display:flex;flex-direction:column;gap:5px;transition:box-shadow .12s}
        .seasn .cells .cell:nth-child(7n){border-right:none}
        .seasn .cell:hover:not(.out){box-shadow:inset 0 0 0 2px rgba(176,116,28,.35)}
        .seasn .cell.sel{box-shadow:inset 0 0 0 2px var(--crust)}
        .seasn .cell.out{cursor:default;background:var(--line2);opacity:.5}
        .seasn .cdate{display:flex;align-items:center;justify-content:space-between;gap:4px}
        .seasn .cdate>span:first-child{font-size:13px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
        .seasn .cell.out .cdate>span{color:var(--muted);font-weight:500}
        .seasn .todayn{background:var(--espresso);color:#f0e6d2;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center}
        .seasn .cmult{font-size:10.5px;font-weight:700;color:var(--muted);font-variant-numeric:tabular-nums}
        .seasn .cmult.up{color:var(--crust-deep)}
        .seasn .cmult.dn{color:#4f7396}
        .seasn .cevs{display:flex;flex-direction:column;gap:3px;margin-top:auto}
        .seasn .cev{font-size:10px;font-weight:600;padding:2px 6px;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35}

        .seasn .rail{position:sticky;top:16px}
        .seasn .daycard{padding:18px 20px}
        .seasn .dc-h{font-family:var(--serif);font-size:16px;font-weight:600}
        .seasn .dc-big{font-family:var(--serif);font-size:38px;font-weight:600;line-height:1;letter-spacing:-1px;font-variant-numeric:tabular-nums;margin:10px 0 4px;display:flex;align-items:baseline;gap:10px}
        .seasn .dc-u{font-size:13px;color:var(--muted);font-weight:500;font-family:var(--sans);letter-spacing:0}
        .seasn .dc-rows{margin-top:14px;border-top:1px solid var(--line2);padding-top:6px}
        .seasn .dcr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line2)}
        .seasn .dcr:last-child{border-bottom:none}
        .seasn .dcr-l{font-size:13px;color:var(--ink2);display:flex;align-items:center;gap:8px}
        .seasn .kd{width:9px;height:9px;border-radius:3px;flex:none}
        .seasn .dcr-v{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--muted)}
        .seasn .dcr-v.up{color:var(--crust-deep)} .seasn .dcr-v.dn{color:#4f7396}
        .seasn .dc-none{font-size:13px;color:var(--muted);padding:6px 0}
        .seasn .dc-foot{font-size:12.5px;color:var(--muted);margin-top:12px;line-height:1.55}
        .seasn .dc-foot b{color:var(--ink)}
        .seasn .dc-empty{font-size:13.5px;color:var(--muted);padding:14px 0;text-align:center}

        .seasn .evlist{overflow:hidden}
        .seasn .ev-none{padding:16px 18px;font-size:13px;color:var(--muted)}
        .seasn .evrow{padding:13px 16px}
        .seasn .ev-top{display:flex;align-items:center;gap:9px}
        .seasn .ev-chip{font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap}
        .seasn .ev-name{font-family:var(--serif);font-size:14.5px;font-weight:600}
        .seasn .ev-step{margin-left:auto;display:flex;align-items:center;gap:2px;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--card)}
        .seasn .ev-step button{width:26px;height:26px;border:none;background:var(--card);cursor:pointer;font-size:15px;color:var(--ink2);font-family:inherit}
        .seasn .ev-step button:hover{background:#f3ecdd}
        .seasn .ev-up{min-width:44px;text-align:center;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--muted)}
        .seasn .ev-up.up{color:var(--crust-deep)} .seasn .ev-up.dn{color:#4f7396}
        .seasn .ev-scope{font-size:12px;color:var(--ink2);font-weight:600;margin-top:6px}
        .seasn .ev-note{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5}
        .seasn .addev{width:100%;border:none;border-top:1px solid var(--line2);background:var(--surface);padding:11px;font-size:12.5px;font-weight:600;color:var(--crust-deep);cursor:pointer;font-family:inherit}
        .seasn .addev:hover{background:#f3ecdd}

        @media (max-width:1080px){ .seasn .grid2{grid-template-columns:1fr} .seasn .rail{position:static} }
      `}</style>
    </div>
  );
}
