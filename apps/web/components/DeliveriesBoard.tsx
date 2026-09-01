"use client";

import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import { setRunState } from "@/app/run-state-actions";
import Link from "next/link";
import type { DeliveryLine, DeliveryDetailLine, WeekdayShape, RunOption } from "@/lib/queries";
import { WD_ORDER, dowMultipliers, dayShare } from "@/lib/dayshare";

// weekday enum -> short label, in week order, for the run-day chips.
const WD_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const titleCaseRegion = (s: string) => (s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const nf = (n: number) => n.toLocaleString("en-AU");
const csvCell = (v: string | number) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const DOWSHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// The "calm" delivery order sheet. The plan sizes each order; Simona works
// through it region by region, nudging any Final delivery number (−/+ appear on
// hover), resetting or undoing, and ticking each store to approve. Each store
// opens a per-product breakdown inline. Totals recalc live. Nothing sends to the
// bakery until she signs it off.
export default function DeliveriesBoard({ lines, detail = [], shape = null, saved = {}, runs = [] }: { lines: DeliveryLine[]; detail?: DeliveryDetailLine[]; shape?: WeekdayShape | null; saved?: Record<string, boolean>; runs?: RunOption[] }) {
  // Delivery run -> its ordered day labels. Simona uses one word for the grouping
  // and the run that services it, so we do too (26 Aug). Region IS the run,
  // so the delivery group header can show the run name + the days it goes out.
  const runDays = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of runs) {
      const days = WD_ORDER.filter((d) => r.days.includes(d)).map((d) => WD_LABEL[d]);
      m.set(r.region.toUpperCase(), days);
    }
    return m;
  }, [runs]);
  // Which of those days are EVENING drops (runs.run_pm). Five runs carry at
  // least one: Central Coast, City, North West, Inner West and Western Sydney.
  // Simona described the Central Coast one on the 26 Aug call — the driver goes
  // Friday night and Sunday night. Stored since migration 052 and shown nowhere
  // until now, so a header reading "Central Coast — Sun, Wed, Fri" told a packer
  // nothing about which of those are night loads. Same labels as runDays so the
  // two line up.
  const runPm = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of runs) {
      m.set(r.region.toUpperCase(), new Set(WD_ORDER.filter((d) => r.pm.includes(d)).map((d) => WD_LABEL[d])));
    }
    return m;
  }, [runs]);
  // Day-split curve (Mon..Sun). Measured from real sell-through when we have it,
  // reindexed from the Sun..Sat shape; else the seed curve. This is the same
  // weekend uplift the Seasonality calendar shows — one shape across the app.
  const DOWMULT = useMemo(
    () => dowMultipliers(shape),
    [shape],
  );
  const orig = useMemo(
    () => Object.fromEntries(lines.map((l) => [l.store_id, l.recommended])) as Record<string, number>,
    [lines],
  );
  // per-store product lines for the inline dropdown
  const detailMap = useMemo(() => {
    const m = new Map<string, DeliveryDetailLine[]>();
    for (const d of detail) {
      if (!m.has(d.store_id)) m.set(d.store_id, []);
      m.get(d.store_id)!.push(d);
    }
    return m;
  }, [detail]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));
  const groups = useMemo(() => {
    const m = new Map<string, DeliveryLine[]>();
    for (const l of lines) {
      const k = l.region ?? "Unassigned";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(l);
    }
    return [...m.entries()].map(([region, rows]) => ({ region, rows }));
  }, [lines]);

  const [eng, setEng] = useState<Record<string, number>>(orig);
  const [approved, setApproved] = useState<Record<string, boolean>>(saved);
  const [, startSave] = useTransition();
  // Persist the approval set so ticks survive a reload (migration 017).
  const persistApproved = (next: Record<string, boolean>) => startSave(async () => { await setRunState("deliveries", next); });
  // Simona, 26 Aug [36:09]: "groups must be COLLAPSED by default." They were
  // not on the call, so she opened the page onto 265 rows and had to scroll to
  // find the run she wanted. Seeded from `lines` rather than `groups` because
  // this runs before groups is computed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries([...new Set(lines.map((l) => l.region ?? "Unassigned"))].map((r) => [r, true])),
  );
  const [term, setTerm] = useState("");
  const [unappOnly, setUnappOnly] = useState(false);
  const [helpOpen, setHelpOpen] = useState(true);
  const [history, setHistory] = useState<{ id: string; prev: number }[][]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [day, setDay] = useState<"week" | number>("week");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isWeek = day === "week";
  // Displayed value for the current view — whole week, or ONE DAY'S SHARE FOR
  // THIS STORE.
  //
  // This used to split the weekly figure across all seven days by the demand
  // curve, for every store, whatever its actual schedule. So a Mon/Wed/Fri
  // store showed a Tuesday delivery — for a day nobody drives to it — and its
  // real Monday drop came out roughly two and a half times too small, because
  // the week was being divided by seven days instead of three. It exported to
  // CSV that way too.
  //
  // `l.days` was already being fetched for exactly this reason (see
  // getDeliveryPlan) and was only being used to print the "3 days a week" chip.
  // Simona, 26 Aug [37:26]: "Edgecliff and Metro Paddington do not get a
  // delivery every day."
  //
  // Now: nothing on a day the store is not delivered, and on a day it IS, the
  // week is divided across only that store's own days, still weighted by the
  // demand curve so Saturday sits at the top of its range and Tuesday near the
  // bottom. A store whose days we do not know shows nothing rather than a
  // number — the seven invoice cafes Simona left blank are exactly that case,
  // and inventing a Tuesday drop for them is worse than admitting we do not
  // know.
  const dv = (n: number, l?: { days?: string[] }) => {
    if (isWeek) return n;
    const i = day as number;
    const days = l?.days ?? [];
    return dayShare(n, days, i, DOWMULT);
  };
  // True when the selected day is one this store actually gets a delivery on.
  const onDay = (l: { days?: string[] }) => isWeek || (l.days ?? []).includes(WD_ORDER[day as number]);
  const v = (id: string) => eng[id] ?? orig[id] ?? 0;
  const total = lines.length;
  const totalSent = lines.reduce((a, l) => a + dv(l.sent, l), 0);
  const totalEng = lines.reduce((a, l) => a + dv(v(l.store_id), l), 0);
  // How much of the selected day leaves the bakery at night rather than on the
  // morning run. Only meaningful on a day tab — across a whole week it is just
  // the sum of the night runs and says nothing about a shift.
  const pmEng = isWeek
    ? 0
    : lines.reduce((a, l) => (l.pm.includes(WD_ORDER[day as number]) ? a + dv(v(l.store_id), l) : a), 0);
  const pmStores = isWeek
    ? 0
    : lines.filter((l) => l.pm.includes(WD_ORDER[day as number])).length;
  const trim = totalSent - totalEng;
  const apprCount = lines.filter((l) => approved[l.store_id]).length;
  const dirty = lines.some((l) => v(l.store_id) !== orig[l.store_id]);
  const engPct = totalSent ? (totalEng / totalSent) * 100 : 100;
  // Stores whose sales we can see, vs stores carried through on their standing
  // order. A store with no live feed has nothing to size against, so the engine
  // passes its standing order straight through — correct, but it means "250
  // stores on plan · 2,926 trimmed" reads as if the trim were spread across all
  // 250 when every unit of it comes from the ones we can see. With the Coles
  // feed down since 3 Aug that's most of the network, and it is the first thing
  // anyone will ask about.
  //
  // This used to be INFERRED: count the rows whose final delivery equalled
  // their standing order and call the rest "stores whose sales we can see".
  // That is a numeric coincidence, not a fact about a feed, and it was wrong
  // twice. A store we can see whose plan lands exactly on its standing order
  // counted as one we cannot. And it read v(), the live edited value, so every
  // nudge moved a number that is supposed to describe the sales feeds — the
  // caption drifted 93 → 94 → 95 across one morning with nothing loaded and no
  // engine run, following the mouse.
  //
  // has_feed comes from the query now: a sales row in the seven days to the
  // as-of clock, the same definition v_store_week uses and the same window
  // jb_plan_day ranges on.
  const sized = lines.filter((l) => l.has_feed).length;
  const untouched = total - sized;
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed[g.region]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }
  // Export the run sheet as it stands — current view (whole week or one day),
  // adjustments included, in the region order shown. Real CSV, no dependency.
  function exportRunSheet() {
    const header = ["Delivery run", "Store", "Sending now", "Final delivery", "Difference", "Approved"];
    const body: string[] = [];
    for (const g of groups) {
      for (const l of g.rows) {
        const sendNow = dv(l.sent, l);
        const finalD = dv(v(l.store_id), l);
        body.push(
          [g.region, l.name, sendNow, finalD, finalD - sendNow, approved[l.store_id] ? "Yes" : ""]
            .map(csvCell)
            .join(","),
        );
      }
    }
    const scope = isWeek ? "week" : DOWSHORT[day as number];
    const csv = [header.map(csvCell).join(","), ...body].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jesses-delivery-run-sheet-${scope}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Run sheet exported — ${lines.length} stores (${isWeek ? "whole week" : dayName})`);
  }
  function setEngine(id: string, val: number, record = true) {
    const next = Math.max(0, Math.floor(Number(val) || 0));
    const cur = v(id);
    if (next === cur) return;
    if (record) setHistory((h) => [...h, [{ id, prev: cur }]]);
    setEng((prev) => ({ ...prev, [id]: next }));
  }
  function resetRow(id: string) {
    const cur = v(id);
    if (cur === orig[id]) return;
    setHistory((h) => [...h, [{ id, prev: cur }]]);
    setEng((prev) => ({ ...prev, [id]: orig[id] }));
  }
  function resetAll() {
    const grp = lines.filter((l) => v(l.store_id) !== orig[l.store_id]).map((l) => ({ id: l.store_id, prev: v(l.store_id) }));
    if (!grp.length) return;
    setHistory((h) => [...h, grp]);
    setEng({ ...orig });
    showToast("Reset — every store back to the plan number");
  }
  function undo() {
    if (!history.length) return;
    const grp = history[history.length - 1];
    setEng((prev) => {
      const next = { ...prev };
      grp.forEach(({ id, prev: p }) => { next[id] = p; });
      return next;
    });
    setHistory((h) => h.slice(0, -1));
  }
  function toggleApprove(id: string) {
    const next = { ...approved, [id]: !approved[id] };
    setApproved(next);
    persistApproved(next);
  }
  function approveRegion(region: string) {
    const rows = groups.find((g) => g.region === region)?.rows ?? [];
    const all = rows.every((l) => approved[l.store_id]);
    const next = { ...approved };
    rows.forEach((l) => { next[l.store_id] = !all; });
    setApproved(next);
    persistApproved(next);
  }
  function toggleRegion(region: string) {
    setCollapsed((c) => ({ ...c, [region]: !c[region] }));
  }
  function collapseAll() {
    if (allCollapsed) setCollapsed({});
    else setCollapsed(Object.fromEntries(groups.map((g) => [g.region, true])));
  }

  const t = term.trim().toLowerCase();
  const rowVisible = (l: DeliveryLine) => (!t || l.name.toLowerCase().includes(t)) && (!unappOnly || !approved[l.store_id]);
  const filtering = !!t || unappOnly;
  const regChg = (f: number) => (f > 0 ? `−${nf(f)}` : f < 0 ? `+${nf(-f)}` : "—");
  function chgPill(l: DeliveryLine) {
    const d = dv(l.sent, l) - dv(v(l.store_id), l);
    if (d > 0) return <span className="chgpill">−{nf(d)}</span>;
    if (d < 0) return <span className="chgpill add">+{nf(-d)}</span>;
    return <span className="chgpill same">—</span>;
  }

  const dayName = isWeek ? "" : DOW[day as number];
  const dayShort = isWeek ? "" : DOWSHORT[day as number];

  return (
    <section className="dcalm">
      <div className="dayrow">
        <span className="daylbl">Show delivery for</span>
        <div className="dayselect">
          <button type="button" className={`daypill ${isWeek ? "on" : ""}`} onClick={() => setDay("week")}>Whole week</button>
          <span className="daysep" />
          {DOWSHORT.map((d, i) => (
            <button type="button" key={d} className={`daypill ${day === i ? "on" : ""}`} onClick={() => setDay(i)}>{d}</button>
          ))}
        </div>
        {shape && (
          <span className="daymeas">
            Day sizes measured from real sales — weekends run <b>{shape.weekendLift > 0 ? "+" : ""}{shape.weekendLift}%</b>,
            so Sat/Sun drops sit at the top of each store&apos;s range and quiet weekdays at the bottom.
          </span>
        )}
      </div>

      <div className="hero">
        <div>
          <div className="lead">
            {isWeek ? (
              <>Right now your standing orders send <b>{nf(totalSent)}</b> loaves this week. Sized to what actually sells, the plan sends <b>{nf(totalEng)}</b></>
            ) : (
              <><b>{dayName}</b> — the current run sends <b>{nf(totalSent)}</b> loaves. Sized to what actually sells, the plan sends <b>{nf(totalEng)}</b></>
            )}
            {trim > 0 ? (
              <> — <span className="fewer">{nf(trim)} less</span>, so far less comes back at day&apos;s end.</>
            ) : trim < 0 ? (
              <> — <span className="fewer" style={{ color: "var(--amber-t)" }}>{nf(-trim)} more</span> after your adjustments.</>
            ) : (
              <>.</>
            )}
            {pmEng > 0 && (
              <span className="carried">
                {" "}Of that, <b>{nf(pmEng)}</b> across <b>{nf(pmStores)}</b>{" "}
                {pmStores === 1 ? "store" : "stores"} goes out on the <b>evening</b> run, so it has to be
                baked and packed a shift earlier than the rest of {dayName}.
              </span>
            )}
            {untouched > 0 && (
              <span className="carried">
                {" "}All of that comes from the <b>{nf(sized)}</b> stores whose sales we can see. The other{" "}
                <b>{nf(untouched)}</b> keep their standing order untouched — there&apos;s nothing to size them against
                until their feed comes back.
              </span>
            )}
          </div>
          <div className="babar">
            <div className="eng" style={{ width: `${engPct}%` }}>Plan {nf(totalEng)}</div>
            {trim > 0 ? <div className="trim" style={{ width: `${100 - engPct}%` }}>−{nf(trim)}</div> : null}
          </div>
          <div className="balegend">
            <span><i style={{ background: "var(--green)" }} />What the plan sends</span>
            <span><i style={{ background: "#ecccbf" }} />Over-supply trimmed</span>
          </div>
        </div>
        <div className="statgrid">
          <div className="s"><div className="n">{total}</div><div className="l">Stores on plan</div></div>
          <div className="s"><div className="n">{groups.length}</div><div className="l">Delivery runs</div></div>
          <div className="s"><div className="n g">{nf(Math.max(0, trim))}</div><div className="l">Loaves trimmed{isWeek ? " / week" : ` · ${dayShort}`}</div></div>
          <div className="s"><div className="n">{apprCount}<span style={{ fontSize: 15, color: "var(--muted)" }}>/{total}</span></div><div className="l">Orders approved</div></div>
        </div>
      </div>

      {helpOpen && (
        <div className="help">
          <span className="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" /></svg></span>
          <div><b>How this sheet works:</b> each row is one store. <b>Sending now</b> is the current standing order. <b>Final delivery</b> is what the plan suggests, sized to real sales. Happy with a store? Tick <b>✓</b>. Disagree? Nudge the number with <b>−/+</b> — or hit reset. Nothing goes to the bakery until you approve it.</div>
          <span className="x" onClick={() => setHelpOpen(false)}>✕</span>
        </div>
      )}

      <div className="toolbar">
        <label className="search">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Find a store…" autoComplete="off" />
        </label>
        <button type="button" className={`tgl ${unappOnly ? "on" : ""}`} onClick={() => setUnappOnly((u) => !u)}>Unapproved only</button>
        {isWeek && <button type="button" className="tgl" onClick={undo} disabled={history.length === 0}>↶ Undo last</button>}
        {isWeek && <button type="button" className="tgl reset" onClick={resetAll} disabled={!dirty}>↺ Reset to plan</button>}
        <button type="button" className="tgl link" onClick={collapseAll}>{allCollapsed ? "Expand all" : "Collapse all"}</button>
      </div>

      <div className="sheet">
        <div className="colhead"><div className="grid">
          <div>Store</div>
          <div className="r hide">Sending now</div>
          <div className="c">Final delivery</div>
          <div className="r">Difference</div>
          <div className="c">Approve</div>
        </div></div>

        {groups.map((g) => {
          const anyVisible = g.rows.some(rowVisible);
          if (!anyVisible) return null;
          // Collapsed by default is right on open and wrong while filtering:
          // with every group shut, a search would return headers and no rows.
          // Any active filter forces the groups open.
          const isC = !!collapsed[g.region] && !filtering;
          const send = g.rows.reduce((a, l) => a + dv(l.sent, l), 0);
          const engs = g.rows.reduce((a, l) => a + dv(v(l.store_id), l), 0);
          const fewer = send - engs;
          return (
            <Fragment key={g.region}>
              <div className={`reghead ${isC ? "collapsed" : ""}`} onClick={() => toggleRegion(g.region)}>
                <div className="grid">
                  <div className="reg-name">
                    <span className="acc" />
                    <span className="rn">{titleCaseRegion(g.region)}<em className="runtag">run</em></span>
                    <span className="cnt">{g.rows.length}</span>
                    {(runDays.get(g.region) ?? []).length > 0 && (
                      <span className="rundays" title="This run's delivery days. A day marked pm is an evening drop — the van goes out at night.">
                        {(runDays.get(g.region) ?? []).map((d) => {
                          const evening = runPm.get(g.region)?.has(d);
                          return <i key={d} className={evening ? "pm" : ""}>{d}{evening ? <b>pm</b> : null}</i>;
                        })}
                      </span>
                    )}
                    <button type="button" className="appall" onClick={(e) => { e.stopPropagation(); approveRegion(g.region); }}>Approve region</button>
                  </div>
                  <div className="reg-send hide">{nf(send)}</div>
                  <div className="reg-eng">{nf(engs)}</div>
                  <div className="reg-chg">{regChg(fewer)}</div>
                  <div className="reg-chev"><svg className="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg></div>
                </div>
              </div>
              {!isC && g.rows.map((l) => {
                if (!rowVisible(l)) return null;
                const val = v(l.store_id);
                const changed = val !== orig[l.store_id];
                const appr = !!approved[l.store_id];
                const prods = detailMap.get(l.store_id) ?? [];
                const open = !!expanded[l.store_id];
                return (
                  <Fragment key={l.store_id}>
                  <div className={`row ${appr ? "approved" : ""} ${changed ? "edited" : ""}`}>
                    <div className="grid">
                      <div className="stname">
                        {prods.length > 0 && (
                          <button type="button" className={`xpand ${open ? "open" : ""}`} aria-label={`${open ? "hide" : "show"} products for ${l.name}`} onClick={() => toggleExpand(l.store_id)}>
                            <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg>
                          </button>
                        )}
                        <Link prefetch={false} href={`/store/${l.store_id}`}><span className="chev">→</span>{l.name}</Link>
                        {/* Per-store frequency, [37:26]. The run's headline days
                            sit on the group header; this is what THIS store
                            actually takes.

                            NO colour for "fewer days than the run". I built that
                            first and looked at it: Eastern Suburbs goes out seven
                            days, so seven of its first eleven stores lit up amber
                            and the highlight stopped meaning anything. Same
                            mistake as the "not on Tue, Wed…" chip on the run
                            board this morning. She asked for the number — "seven
                            days, six days, four days, and so on" — and the number
                            says it without help.

                            Red stays for no days at all, because that is not a
                            frequency, it is a store nobody is scheduled to visit
                            sitting on an order sheet waiting to be approved. */}
                        {l.days.length === 0 ? (
                          <span className="freq none">no delivery days set</span>
                        ) : (
                          <span className="freq">
                            {l.days.length} {l.days.length === 1 ? "day" : "days"} a week
                          </span>
                        )}
                        {/* Evening drops. In week view it names which of this
                            store's days are night loads; on a day tab it only
                            appears when THAT day is one, so the row says what
                            the shift is without the reader working it out. */}
                        {(isWeek ? l.pm.length > 0 : l.pm.includes(WD_ORDER[day as number])) && (
                          <span className="pmchip" title="Evening drop — this one goes out at night, not on the morning run">
                            {isWeek
                              ? `evening ${WD_ORDER.filter((d) => l.pm.includes(d)).map((d) => WD_LABEL[d]).join(", ")}`
                              : "evening drop"}
                          </span>
                        )}
                      </div>
                      <div className="sendnow hide">{onDay(l) ? nf(dv(l.sent, l)) : "—"}</div>
                      {isWeek ? (
                        <div className="engcell"><div className="stepper">
                          <button type="button" aria-label={`decrease ${l.name}`} onClick={() => setEngine(l.store_id, val - 1)}>−</button>
                          <input
                            className={changed ? "edited" : ""}
                            value={val}
                            inputMode="numeric"
                            onChange={(e) => setEngine(l.store_id, parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}
                            onFocus={(e) => e.currentTarget.select()}
                          />
                          <button type="button" aria-label={`increase ${l.name}`} onClick={() => setEngine(l.store_id, val + 1)}>+</button>
                        </div></div>
                      ) : (
                        <div className="engcell"><div className="engnum">{onDay(l) ? nf(dv(val, l)) : "—"}</div></div>
                      )}
                      <div className="chg">
                        {isWeek && changed && (
                          <button type="button" className="rst" title={`Reset to ${orig[l.store_id]}`} onClick={() => resetRow(l.store_id)}>
                            <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" /></svg>
                          </button>
                        )}
                        {chgPill(l)}
                      </div>
                      <div className="appcell">
                        <button type="button" className={`appbtn ${appr ? "on" : ""}`} aria-label={`approve ${l.name}`} onClick={() => toggleApprove(l.store_id)}>
                          <svg viewBox="0 0 24 24"><path d="M5 12l5 5 10-11" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                  {open && prods.map((p) => {
                    const psent = dv(Number(p.sent) || 0, l);
                    const prec = dv(Number(p.recommended) || 0, l);
                    const d = psent - prec;
                    return (
                      <div className="prow" key={p.product_name}>
                        <div className="grid">
                          <div className="pname">{p.product_name}</div>
                          <div className="sendnow hide">{nf(psent)}</div>
                          <div className="peng">{nf(prec)}</div>
                          <div className="pchg">{d > 0 ? `−${nf(d)}` : d < 0 ? `+${nf(-d)}` : "—"}</div>
                          <div />
                        </div>
                      </div>
                    );
                  })}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      <div className="foot">
        {isWeek
          ? <>Calm by default — the −/+ controls appear when you hover a row, and the number reads like plain text until you change it. Click a store to see its per-product breakdown. Tick to approve. Your store approvals save and stay across reloads; the quantity nudges are a working draft, and sending the run to the bakery is the next build phase. Switch to a day above to see just that day&apos;s drop — the buffer is already baked into every number.</>
          : <><b>{dayName}&apos;s</b> share of the week&apos;s plan — read-only. Click a store for its per-product breakdown, or tick to approve. To change quantities, switch back to <b>Whole week</b>. This day&apos;s split is {shape ? "sized from the measured weekday shape" : "modelled from typical demand"} until the daily plan is wired.</>}
      </div>

      <div className="actionbar">
        <div className="prog"><b>{apprCount}</b> of {total} approved · trimming <span className="tr">{nf(Math.max(0, trim))}</span> loaves {isWeek ? "this week" : dayShort}</div>
        <div className="sp">
          <button type="button" className="btn" onClick={exportRunSheet}>↓ Export run sheet</button>
          <button type="button" className="btn primary" onClick={() => { const next = Object.fromEntries(lines.map((l) => [l.store_id, true])); setApproved(next); persistApproved(next); showToast(`All ${total} orders approved ✓ — saved`); }}>✓ Approve all</button>
        </div>
      </div>

      {toast && <div className="toast"><span>{toast}</span></div>}

      <style>{`
      .dcalm{display:block;padding-bottom:72px}
      .dcalm .dayrow{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
      .dcalm .daymeas{flex-basis:100%;font-size:12px;color:var(--muted);line-height:1.5}
      .dcalm .daymeas b{color:var(--ink);font-weight:700}
      .dcalm .daylbl{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.2px}
      .dcalm .dayselect{display:flex;gap:4px;background:#ece3d1;border-radius:11px;padding:4px;flex-wrap:wrap}
      .dcalm .daypill{border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);padding:8px 14px;border-radius:8px;cursor:pointer;transition:.14s}
      .dcalm .daypill:hover{color:var(--ink2)}
      .dcalm .daypill.on{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(60,45,30,.16)}
      .dcalm .daysep{width:1px;height:22px;background:#d8ccb2;margin:0 2px}
      .dcalm .engnum{text-align:center;font-weight:700;font-size:15px;font-variant-numeric:tabular-nums}
      .dcalm .stname .xpand{width:20px;height:20px;border:1px solid var(--line);background:var(--card);border-radius:6px;cursor:pointer;color:var(--muted);display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;margin-right:2px}
      .dcalm .stname .xpand svg{width:12px;height:12px;stroke:currentColor;stroke-width:2.4;fill:none;transition:transform .18s}
      .dcalm .stname .xpand.open svg{transform:rotate(180deg)}
      .dcalm .stname .xpand:hover{border-color:var(--crust);color:var(--ink2)}
      .dcalm .prow{border-top:1px solid var(--line2);background:#fbf8f1}
      .dcalm .prow>.grid>div{padding:8px 18px}
      .dcalm .prow .pname{font-size:13px;color:var(--ink2);padding-left:46px !important}
      .dcalm .prow .peng{text-align:center;font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}
      .dcalm .prow .pchg{text-align:right;font-size:12.5px;color:var(--green-t);font-weight:600;font-variant-numeric:tabular-nums}
      .dcalm .hero{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:22px 26px;margin-bottom:16px;display:grid;grid-template-columns:1.5fr 1fr;gap:30px;align-items:center}
      @media(max-width:960px){.dcalm .hero{grid-template-columns:1fr;gap:22px}}
      .dcalm .lead{font-size:15.5px;line-height:1.5}
      .dcalm .carried{display:block;margin-top:6px;font-size:13px;color:var(--muted)}
      .dcalm .lead b{font-weight:700}
      .dcalm .fewer{color:var(--green-t);font-weight:700}
      .dcalm .babar{margin-top:16px;height:24px;border-radius:8px;overflow:hidden;display:flex;background:#f0e9db;box-shadow:inset 0 0 0 1px var(--line2)}
      .dcalm .babar .eng{background:linear-gradient(90deg,#6f9c67,#5f8f5a);display:flex;align-items:center;padding-left:12px;color:#fff;font-size:12px;font-weight:700;white-space:nowrap;transition:width .5s}
      .dcalm .babar .trim{background:repeating-linear-gradient(45deg,#f3dbd1,#f3dbd1 6px,#efd2c6 6px,#efd2c6 12px);display:flex;align-items:center;justify-content:flex-end;padding-right:12px;color:var(--red-t);font-size:12px;font-weight:700;white-space:nowrap;transition:width .5s}
      .dcalm .balegend{display:flex;gap:18px;margin-top:10px;font-size:11.5px;color:var(--muted)}
      .dcalm .balegend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
      .dcalm .statgrid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:12px;overflow:hidden}
      .dcalm .statgrid .s{background:var(--card);padding:14px 16px}
      .dcalm .statgrid .s .n{font-family:var(--serif);font-size:25px;font-weight:600;letter-spacing:-.5px;font-variant-numeric:tabular-nums;line-height:1}
      .dcalm .statgrid .s .l{font-size:11px;color:var(--muted);margin-top:6px}
      .dcalm .statgrid .s .n.g{color:var(--green-t)}
      .dcalm .help{display:flex;align-items:flex-start;gap:12px;background:linear-gradient(135deg,#fffdf8,#fbf5e8);border:1px solid var(--line);border-radius:12px;padding:13px 16px;margin-bottom:14px;font-size:13px;line-height:1.55;color:var(--ink2)}
      .dcalm .help .ic{width:26px;height:26px;border-radius:7px;background:var(--amber-b);display:flex;align-items:center;justify-content:center;flex:none}
      .dcalm .help .ic svg{width:15px;height:15px;stroke:var(--amber-t);stroke-width:2;fill:none}
      .dcalm .help b{color:var(--ink);font-weight:600}
      .dcalm .help .x{margin-left:auto;color:var(--faint);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;flex:none}
      .dcalm .help .x:hover{color:var(--ink2)}
      .dcalm .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
      .dcalm .search{flex:1;min-width:200px;display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:0 12px;box-shadow:var(--sh)}
      .dcalm .search:focus-within{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .dcalm .search svg{width:16px;height:16px;stroke:var(--muted);stroke-width:1.9;fill:none}
      .dcalm .search input{flex:1;border:none;background:transparent;padding:11px 2px;font-size:14px;font-family:inherit;outline:none}
      .dcalm .tgl{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:10px 15px;font-size:13px;font-weight:600;cursor:pointer;color:var(--ink2);box-shadow:var(--sh);font-family:inherit;display:inline-flex;align-items:center;gap:7px}
      .dcalm .tgl:hover{background:#f6f0e6}
      .dcalm .tgl.on{background:var(--espresso);border-color:var(--espresso);color:#f4ecdc}
      .dcalm .tgl:disabled{opacity:.4;cursor:default;background:var(--card)}
      .dcalm .tgl.link{background:transparent;border-color:transparent;box-shadow:none;color:var(--crust-deep)}
      .dcalm .tgl.reset:not(:disabled){background:#fdf6e7;border-color:var(--amber);color:var(--amber-t)}
      .dcalm .tgl.reset:not(:disabled):hover{background:#fbeed2}
      .dcalm .sheet{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh)}
      .dcalm .grid{display:grid;grid-template-columns:minmax(210px,1fr) 128px 150px 120px 104px;align-items:center}
      /* Sticky column header — this is a work-through spreadsheet, so the labels
         stay put as she scrolls the 30 rows. (Needs the sheet NOT to be
         overflow:hidden, which previously clipped it into a non-scrolling box.) */
      .dcalm .colhead{background:var(--surface);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;border-top-left-radius:var(--r);border-top-right-radius:var(--r)}
      .dcalm .sheet>:last-child{border-bottom-left-radius:var(--r);border-bottom-right-radius:var(--r)}
      .dcalm .colhead .grid>div{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:12px 18px}
      .dcalm .colhead .r{text-align:right}.dcalm .colhead .c{text-align:center}
      .dcalm .colhead .grid>div:last-child{padding-right:24px}
      .dcalm .colhead + .reghead{border-top:none}
      .dcalm .reghead{border-top:1px solid var(--line);cursor:pointer;background:#faf6ee}
      .dcalm .reghead>.grid>div{padding:11px 18px}
      .dcalm .reg-name{display:flex;align-items:center;gap:11px}
      .dcalm .reghead .acc{width:5px;height:22px;border-radius:4px;flex:none;background:var(--crust)}
      .dcalm .reghead .rn{font-family:var(--serif);font-size:15.5px;font-weight:600;letter-spacing:-.2px}
      .dcalm .reghead .rn .runtag{font-family:var(--sans);font-style:normal;font-size:11px;font-weight:600;color:var(--faint);margin-left:6px}
      .dcalm .reghead .cnt{background:#efe6d3;color:var(--ink2);border-radius:999px;font-size:11px;font-weight:700;padding:2px 9px}
      .dcalm .reghead .rundays{display:inline-flex;gap:4px}
      .dcalm .reghead .rundays i{font-style:normal;font-size:10.5px;font-weight:700;color:var(--crust-deep);background:#f2e7d2;border-radius:5px;padding:2px 6px;letter-spacing:.02em}
      /* Evening drop. Deliberately a night colour rather than a warning one —
         a night run is normal, it is just a different shift, and amber here
         would read as "something is wrong with this day". */
      .dcalm .reghead .rundays i.pm{color:#e8e3f2;background:#3f3a56}
      .dcalm .reghead .rundays i.pm b{font-weight:800;font-size:8.5px;margin-left:3px;opacity:.75;text-transform:uppercase;letter-spacing:.06em}
      .dcalm .reg-send{text-align:right;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
      .dcalm .reg-eng{text-align:center;color:var(--ink);font-weight:700;font-size:14px;font-variant-numeric:tabular-nums}
      .dcalm .reg-chg{text-align:right;color:var(--crust-deep);font-weight:700;font-size:13px;font-variant-numeric:tabular-nums}
      .dcalm .reg-chev{display:flex;justify-content:center;padding-right:20px !important}
      .dcalm .reghead .chev{width:15px;height:15px;stroke:var(--muted);stroke-width:2.2;fill:none;transition:transform .2s;flex:none}
      .dcalm .reghead.collapsed .chev{transform:rotate(-90deg)}
      .dcalm .freq{margin-left:10px;font-size:11px;font-weight:600;color:var(--muted);background:var(--bg2,rgba(0,0,0,.04));padding:2px 7px;border-radius:5px;white-space:nowrap}
      .dcalm .freq.none{background:var(--red-b);color:var(--red-t)}
      .dcalm .pmchip{margin-left:6px;font-size:11px;font-weight:700;color:#e8e3f2;background:#3f3a56;padding:2px 7px;border-radius:5px;white-space:nowrap}
      .dcalm .reghead .appall{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;opacity:0;transition:.14s;margin-left:4px}
      .dcalm .reghead:hover .appall{opacity:1}
      .dcalm .row{border-top:1px solid var(--line2);transition:background .12s}
      .dcalm .row:hover{background:#faf6ee}
      .dcalm .row.approved{background:#f4f8f1}
      .dcalm .row>.grid>div{padding:12px 18px}
      .dcalm .stname{font-weight:600;letter-spacing:-.1px;cursor:pointer;display:flex;align-items:center;gap:8px}
      .dcalm .stname .chev{opacity:0;color:var(--crust);font-weight:700;transition:.15s}
      .dcalm .row:hover .stname .chev{opacity:1}
      .dcalm .sendnow{text-align:right;font-variant-numeric:tabular-nums;color:var(--faint)}
      .dcalm .engcell{padding-left:18px !important;padding-right:18px !important}
      .dcalm .stepper{display:flex;align-items:center;justify-content:center;gap:6px}
      .dcalm .stepper button{width:26px;height:26px;border:1px solid var(--line);background:var(--card);border-radius:7px;font-size:15px;line-height:1;cursor:pointer;color:var(--ink2);font-family:inherit;display:flex;align-items:center;justify-content:center;transition:.12s;opacity:0}
      .dcalm .stepper button:hover{background:#f3ecdd;border-color:var(--crust)}
      .dcalm .row:hover .stepper button,.dcalm .engcell:focus-within .stepper button{opacity:1}
      .dcalm .stepper input{width:56px;text-align:center;border:1px solid transparent;border-radius:7px;padding:6px 8px;font-size:15px;font-weight:700;font-family:inherit;font-variant-numeric:tabular-nums;color:var(--ink);background:transparent;outline:none;transition:.12s;cursor:pointer}
      .dcalm .row:hover .stepper input{border-color:var(--line);background:var(--surface)}
      .dcalm .stepper input:focus{border-color:var(--crust);background:#fff;box-shadow:0 0 0 3px rgba(176,116,28,.13);cursor:text}
      .dcalm .stepper input.edited{border-color:var(--amber);background:#fdf6e7;box-shadow:0 0 0 2px rgba(198,138,46,.14)}
      .dcalm .chg{display:flex;align-items:center;justify-content:flex-end;gap:8px}
      .dcalm .rst{width:22px;height:22px;border:1px solid var(--line);background:var(--card);border-radius:6px;cursor:pointer;color:var(--crust-deep);display:flex;align-items:center;justify-content:center;flex:none;font-family:inherit;padding:0}
      .dcalm .rst svg{width:13px;height:13px;stroke:currentColor;stroke-width:2;fill:none}
      .dcalm .rst:hover{background:#f7ede0;border-color:var(--crust)}
      .dcalm .chgpill{font-weight:600;font-size:13px;font-variant-numeric:tabular-nums;color:var(--green-t)}
      .dcalm .chgpill.add{color:var(--amber-t)}
      .dcalm .chgpill.same{color:var(--faint)}
      .dcalm .appcell{display:flex;justify-content:center;padding-right:20px !important}
      .dcalm .appbtn{width:28px;height:28px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.14s;padding:0}
      .dcalm .appbtn svg{width:15px;height:15px;stroke:var(--faint);stroke-width:2.4;fill:none;transition:.14s}
      .dcalm .appbtn:hover{border-color:var(--green)}
      .dcalm .appbtn.on{background:var(--green);border-color:var(--green)}
      .dcalm .appbtn.on svg{stroke:#fff}
      .dcalm .foot{margin-top:24px;font-size:11.5px;color:var(--faint);line-height:1.6}
      .dcalm .actionbar{position:fixed;left:236px;right:0;bottom:0;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-top:1px solid var(--line);box-shadow:0 -6px 20px -12px rgba(60,45,30,.25);padding:12px clamp(18px,3.4vw,60px);display:flex;align-items:center;gap:16px;z-index:30;flex-wrap:wrap}
      .dcalm .actionbar .prog{font-size:13.5px;color:var(--ink2)}
      .dcalm .actionbar .prog b{font-weight:700}
      .dcalm .actionbar .prog .tr{color:var(--green-t);font-weight:700}
      .dcalm .actionbar .sp{margin-left:auto;display:flex;gap:10px}
      .dcalm .btn{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 18px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink);display:inline-flex;align-items:center;gap:8px}
      .dcalm .btn:hover{background:#f6f0e6}
      .dcalm .btn.primary{background:var(--espresso);border-color:var(--espresso);color:#f4ecdc}
      .dcalm .btn.primary:hover{background:#392b20}
      .dcalm .toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13.5px;font-weight:500;z-index:60;display:flex;gap:10px;align-items:center;max-width:88vw}
      @media(max-width:900px){.dcalm .actionbar{left:0}}
      @media(max-width:820px){.dcalm .grid{grid-template-columns:minmax(150px,1fr) 150px 100px 60px}.dcalm .colhead .hide,.dcalm .row .hide,.dcalm .reghead .hide{display:none}}
      @media(max-width:720px){.dcalm .stepper button{opacity:1}}
      `}</style>
    </section>
  );
}
