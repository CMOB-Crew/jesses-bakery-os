"use client";

import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { setRunState } from "@/app/run-state-actions";
import { stripPack } from "@/lib/bake";
import type { ProductionLine, TraySpec, WeekdayShape } from "@/lib/queries";

const nf = (n: number) => n.toLocaleString("en-AU");
const titleCase = (t: string) => t.replace(/\b\w/g, (c) => c.toUpperCase());
const csvCell = (v: string | number) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Accent per bread family — falls back to crust for anything new.
const CAT_COLOR: Record<string, string> = {
  Sourdough: "#b0741c",
  Bagel: "#c68a2e",
  Challah: "#c9a13a",
  Other: "#5f8f5a",
  Pita: "#7d8b3f",
  Pastry: "#b5657a",
};
const catColor = (c: string) => CAT_COLOR[c] ?? "var(--crust)";

// Jesse's floor runs two separate production sheets, not one (his own sheets,
// 3 + 11 Aug). Sourdough is its own run because it's made the day before it's
// baked and delivered the day after — a three-day cycle against the regular
// sheet's bake-then-deliver. Dark rye rides with the sourdough sheet on
// Jesse's, even though it isn't categorised as sourdough.
type Sheet = "regular" | "sourdough";
const sheetOf = (l: { name: string; category: string }): Sheet =>
  l.category.toLowerCase().includes("sourdough") || /dark\s*rye/i.test(l.name) ? "sourdough" : "regular";
const SHEET_LABEL: Record<Sheet, string> = { regular: "Regular", sourdough: "Sourdough" };


const DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DOWSHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Fallback demand curve (Mon..Sun) — quieter Mon/Tue, heavy Fri/Sat/Sun.
// Used only until there's a measured weekday shape; weekly totals stay exact.
const SEED_DOWMULT = [0.85, 0.85, 0.95, 1, 1.3, 1.55, 1.4];

type Day = "week" | number;

// The "calm" bake sheet. The plan sizes each product to real demand; Simona
// works down it by bread type, nudging any Engine-plan number (−/+ appear on
// hover), resetting or undoing, and ticking each line to confirm. Flip to a
// single day to hand the floor exactly what to make that day. Totals recalc live.
export default function ProductionBoard({ lines: raw, shape = null, saved = {}, traySizes = {} }: { lines: ProductionLine[]; shape?: WeekdayShape | null; saved?: Record<string, boolean>; traySizes?: Record<string, TraySpec> }) {
  // Day-split curve (Mon..Sun) — measured from real sell-through when we have
  // it (reindexed from the Sun..Sat shape), else the seed. Same shape the
  // Deliveries board and Seasonality calendar use — the factory bakes to the
  // real weekend curve.
  const DOWMULT = useMemo(
    () => (shape?.shape ? [1, 2, 3, 4, 5, 6, 0].map((i) => shape.shape[i]) : SEED_DOWMULT),
    [shape],
  );
  const DSUM = DOWMULT.reduce((a, b) => a + b, 0);
  // Coerce every numeric field up front — Postgres returns decimals as strings,
  // and even ::int sums are cheap to harden. Keeps arithmetic + toLocaleString safe.
  // State filter (NSW/ACT/QLD). The plan arrives split per state — one row per
  // product per state — so every total on this page is summed from the same
  // filtered rows. Nothing here reads a separately-aggregated network figure,
  // which is what would let the headline and the list disagree.
  const [stateF, setStateF] = useState("all");
  const stateOpts = useMemo(
    () => [...new Set(raw.map((l) => l.state).filter((x): x is string => !!x))].sort(),
    [raw],
  );

  // Items per tray, keyed by the MERGED name. baking_qty is a property of the
  // physical bagel, so every SKU that strips to the same name has to agree on
  // it. If two ever disagree the data is wrong and we do not quietly pick one:
  // that line loses its tray figure and shows items, which is exactly what this
  // sheet has always done for a size it does not know.
  const bakeTray = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [product, spec] of Object.entries(traySizes)) {
      const k = stripPack(product);
      const prev = m.get(k);
      if (prev === undefined) m.set(k, spec.qty);
      else if (prev !== spec.qty) m.set(k, null);
    }
    return m;
  }, [traySizes]);

  // ONE ROW PER THING THE FLOOR BAKES, COUNTED IN INDIVIDUAL ITEMS.
  //
  // Simona, four times on 1 Sept: "They're not baking bags of five. They just
  // need the number of trays. Overall." (28:49) BAGEL - PLAIN (X 5),
  // BAGEL - PLAIN (X 3) and BAGEL - PLAIN are three sold SKUs and one bake, so
  // the suffix comes off and the rows are added. Renaming alone would put three
  // rows called "BAGEL - PLAIN" on one sheet at 733, 1 and 26 trays.
  //
  // Adding them means converting first -- a bag of five is five bagels, and you
  // cannot add bags to bagels. So every number below is individual items: the
  // only unit the three rows share, and the unit a tray divides into. Multiply
  // before dividing, never units / (qty / pack): equal in real arithmetic, not
  // in floating point, where 24 / (24/5) is 5.000000000000001 and ceils to six
  // trays instead of five.
  //
  // Only tray-counted products merge. Anything else keeps its full name --
  // pita is sold in fours but has no tray size, so its units are already what
  // the sheet has always shown and stripping the suffix would merge two rows
  // without converting them.
  const allLines = useMemo(() => {
    const m = new Map<string, { name: string; category: string; sent: number; recommended: number; stores: number }>();
    for (const l of raw) {
      if (stateF !== "all" && l.state !== stateF) continue;
      const spec = traySizes[l.name];
      const key = spec ? stripPack(l.name) : l.name;
      const pack = spec && spec.pack > 0 ? spec.pack : 1;
      const row = m.get(key) ?? {
        name: key,
        category: titleCase(l.category || "Other"),
        sent: 0,
        recommended: 0,
        stores: 0,
      };
      row.sent += (Number(l.sent) || 0) * pack;
      row.recommended += (Number(l.recommended) || 0) * pack;
      // A store sits in exactly one state, and the store taking five-packs is
      // never the store taking them loose -- supermarkets do not buy singles,
      // and Jesse's Cafe is the only loose-bagel customer (Simona: "your only
      // anomaly here is bagels"). So summing the per-state, per-SKU counts
      // gives the true store count for the bake.
      row.stores += Number(l.stores) || 0;
      m.set(key, row);
    }
    return [...m.values()];
  }, [raw, stateF, traySizes]);

  // Which of Jesse's two sheets the floor is looking at. Adjustments are keyed
  // by product name and held across the switch, so flipping sheets never
  // loses a nudge. Everything below reads `lines` — the visible sheet only.
  // Start on Regular, unless the plan somehow holds only sourdough lines —
  // never open on an empty sheet.
  const [sheet, setSheet] = useState<Sheet>(() => (allLines.some((l) => sheetOf(l) === "regular") ? "regular" : "sourdough"));
  const lines = useMemo(() => allLines.filter((l) => sheetOf(l) === sheet), [allLines, sheet]);
  const sheetCounts = useMemo(
    () => ({
      regular: allLines.filter((l) => sheetOf(l) === "regular").length,
      sourdough: allLines.filter((l) => sheetOf(l) === "sourdough").length,
    }),
    [allLines],
  );

  const orig = useMemo(
    () => Object.fromEntries(allLines.map((l) => [l.name, l.recommended])) as Record<string, number>,
    [allLines],
  );

  // categories, biggest bake first
  const groups = useMemo(() => {
    const m = new Map<string, typeof lines>();
    for (const l of lines) {
      if (!m.has(l.category)) m.set(l.category, []);
      m.get(l.category)!.push(l);
    }
    return [...m.entries()]
      .map(([category, rows]) => ({ category, rows, sent: rows.reduce((a, r) => a + r.sent, 0) }))
      .sort((a, b) => b.sent - a.sent);
  }, [lines]);

  // Unit of measure is per PRODUCT, not per category. Jesse bakes mini bagels
  // 40 to a tray and regular bagels 24, so a single number for "bagels" cannot
  // be right for both — his own Products_Master has always held it per line.
  // Sizes come from there via migration 024; an empty map (migration not yet
  // applied, or a product we have no size for) means the sheet shows units and
  // waits rather than inventing a tray figure.
  const traySizeOf = (bake: string) => {
    const n = bakeTray.get(bake);
    return n && n > 0 ? n : null;
  };
  const isTray = (product: string) => traySizeOf(product) != null;
  // Items in, trays out. The pack multiply already happened once, up in the
  // merge -- doing it again here would multiply five-packs by twenty-five.
  const traysFor = (items: number, bake: string) => {
    const sz = traySizeOf(bake);
    return sz ? Math.ceil(items / sz) : null;
  };
  // Trays across a whole category, summed per product — two lines in the same
  // category can have different tray sizes, so this cannot be one division.
  const catTraysFor = (rows: { name: string }[], unitsOf: (name: string) => number) => {
    let total = 0;
    let any = false;
    for (const r of rows) {
      const n = traysFor(unitsOf(r.name), r.name);
      if (n != null) {
        total += n;
        any = true;
      }
    }
    return any ? total : null;
  };
  // Jesse's sheet states the tray-counted lines in trays — the tray count is
  // the number the floor works to, with the unit total underneath.
  const qtyCell = (units: number, product: string) => {
    const t = traysFor(units, product);
    if (t == null) return <>{nf(units)}</>;
    return (
      <>
        {nf(t)}<span className="uomsub">{t === 1 ? "tray" : "trays"}</span>
        <span className="unitsub">{nf(units)} items</span>
      </>
    );
  };

  const [day, setDay] = useState<Day>("week");
  const [eng, setEng] = useState<Record<string, number>>(orig);
  const [approved, setApproved] = useState<Record<string, boolean>>(saved);
  const [, startSave] = useTransition();
  // Persist the week-approval set so ticks survive a reload (migration 017).
  const persistApproved = (next: Record<string, boolean>) => startSave(async () => { await setRunState("production", next); });
  const [baked, setBaked] = useState<Record<string, Record<string, boolean>>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [term, setTerm] = useState("");
  const [unappOnly, setUnappOnly] = useState(false);
  const [helpOpen, setHelpOpen] = useState(true);
  const [history, setHistory] = useState<{ name: string; prev: number }[][]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [today, setToday] = useState<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "today" tag — read the clock client-side only, so SSR and the first client
  // render agree (no hydration mismatch on the day boundary). This is the exact
  // "sync from an external system on mount" case effects exist for.
  useEffect(() => {
    const js = new Date().getDay(); // 0=Sun..6=Sat
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot clock read on mount
    setToday(js === 0 ? 6 : js - 1); // -> Mon=0..Sun=6
  }, []);

  const isWeek = day === "week";
  // Adjustments belong to the whole-network plan. Filtered to one state the
  // board is a read-only view of what that state needs — editing there would
  // be ambiguous (is the nudge for NSW, or for the factory?), so we don't
  // pretend to support it, and we don't show network edits over state numbers.
  const editable = isWeek && stateF === "all";
  const val = (name: string) => (stateF === "all" ? eng[name] ?? orig[name] ?? 0 : orig[name] ?? 0);
  // displayed value for the current view (whole week, or one day's share)
  const dv = (n: number) => (isWeek ? n : Math.round((n * DOWMULT[day as number]) / DSUM));
  const isDone = (name: string) => (isWeek ? !!approved[name] : !!baked[String(day)]?.[name]);

  const total = lines.length;
  const totalSent = lines.reduce((a, l) => a + dv(l.sent), 0);
  const totalEng = lines.reduce((a, l) => a + dv(val(l.name)), 0);
  const trim = totalSent - totalEng;
  const doneCount = lines.filter((l) => isDone(l.name)).length;
  const dirty = lines.some((l) => val(l.name) !== orig[l.name]);
  const engPct = totalSent ? (totalEng / totalSent) * 100 : 100;
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed[g.category]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }
  // Export the bake sheet as it stands — current view (whole week or the
  // selected day, with the day-split), any adjustments applied, grouped by
  // category in bake order. Real CSV the floor can open and print.
  function exportBakeSheet() {
    const header = ["Sheet", "Category", "Product", "Qty", "UoM", "Items", "Current bake", "Difference", "Stores", isWeek ? "Confirmed" : "Baked"];
    const body: string[] = [];
    for (const g of groups) {
      for (const l of g.rows) {
        const cur = dv(l.sent);
        const plan = dv(val(l.name));
        const trays = traysFor(plan, l.name);
        body.push(
          [SHEET_LABEL[sheet], g.category, l.name, trays ?? plan, isTray(l.name) ? "TRAY" : "UNIT", plan, cur, plan - cur, l.stores, isDone(l.name) ? "Yes" : ""]
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
    a.download = `jesses-${sheet}-bake-sheet-${scope}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`${SHEET_LABEL[sheet]} sheet exported — ${lines.length} lines (${isWeek ? "whole week" : dayName})`);
  }
  function setEngine(name: string, next: number, record = true) {
    if (!isWeek) return;
    const n = Math.max(0, Math.floor(Number(next) || 0));
    const cur = val(name);
    if (n === cur) return;
    if (record) setHistory((h) => [...h, [{ name, prev: cur }]]);
    setEng((prev) => ({ ...prev, [name]: n }));
  }
  function resetRow(name: string) {
    if (!isWeek) return;
    const cur = val(name);
    if (cur === orig[name]) return;
    setHistory((h) => [...h, [{ name, prev: cur }]]);
    setEng((prev) => ({ ...prev, [name]: orig[name] }));
  }
  function resetAll() {
    if (!isWeek) return;
    const grp = lines.filter((l) => val(l.name) !== orig[l.name]).map((l) => ({ name: l.name, prev: val(l.name) }));
    if (!grp.length) return;
    setHistory((h) => [...h, grp]);
    setEng({ ...orig });
    showToast("Reset — every line back to the plan");
  }
  function undo() {
    if (!isWeek || !history.length) return;
    const grp = history[history.length - 1];
    setEng((prev) => {
      const next = { ...prev };
      grp.forEach(({ name, prev: p }) => { next[name] = p; });
      return next;
    });
    setHistory((h) => h.slice(0, -1));
  }
  function toggleDone(name: string) {
    if (isWeek) { const next = { ...approved, [name]: !approved[name] }; setApproved(next); persistApproved(next); }
    else setBaked((b) => { const k = String(day); return { ...b, [k]: { ...b[k], [name]: !b[k]?.[name] } }; });
  }
  function doneCat(category: string) {
    const rows = groups.find((g) => g.category === category)?.rows ?? [];
    const all = rows.every((l) => isDone(l.name));
    if (isWeek) { const next = { ...approved }; rows.forEach((l) => { next[l.name] = !all; }); setApproved(next); persistApproved(next); }
    else setBaked((b) => { const k = String(day); const n = { ...(b[k] ?? {}) }; rows.forEach((l) => { n[l.name] = !all; }); return { ...b, [k]: n }; });
  }
  function toggleCat(category: string) {
    setCollapsed((c) => ({ ...c, [category]: !c[category] }));
  }
  function collapseAll() {
    if (allCollapsed) setCollapsed({});
    else setCollapsed(Object.fromEntries(groups.map((g) => [g.category, true])));
  }

  const t = term.trim().toLowerCase();
  const rowVisible = (name: string) => (!t || name.toLowerCase().includes(t)) && (!unappOnly || !isDone(name));
  const catChg = (f: number) => (f > 0 ? `−${nf(f)}` : f < 0 ? `+${nf(-f)}` : "—");
  function chgPill(l: (typeof lines)[number]) {
    const d = dv(l.sent) - dv(val(l.name));
    if (d > 0) return <span className="chgpill">−{nf(d)}</span>;
    if (d < 0) return <span className="chgpill add">+{nf(-d)}</span>;
    return <span className="chgpill same">—</span>;
  }

  const dayName = isWeek ? "" : DOW[day as number];
  const dayShort = isWeek ? "" : DOWSHORT[day as number];
  const isToday = !isWeek && today === day;

  return (
    <section className="pcalm">
      {sheetCounts.regular > 0 && sheetCounts.sourdough > 0 && (
        <div className="sheetrow">
          <span className="lbl">Sheet</span>
          <div className="sheetselect">
            {(["regular", "sourdough"] as Sheet[]).map((s) => (
              <button type="button" key={s} className={`sheetpill ${sheet === s ? "on" : ""}`} onClick={() => setSheet(s)}>
                {SHEET_LABEL[s]}<span className="cnt">{sheetCounts[s]}</span>
              </button>
            ))}
          </div>
          <span className="sheetnote">
            {sheet === "sourdough"
              ? "Sourdough runs its own sheet at Jesse's — made the day before it's baked, then delivered the day after."
              : "Bagels, challah, babkas, bread and pastries — baked, then delivered the next day."}
          </span>
        </div>
      )}

      {stateOpts.length > 1 && (
        <div className="sheetrow">
          <span className="lbl">State</span>
          <div className="sheetselect">
            <button type="button" className={`sheetpill ${stateF === "all" ? "on" : ""}`} onClick={() => setStateF("all")}>All states</button>
            {stateOpts.map((st) => (
              <button type="button" key={st} className={`sheetpill ${stateF === st ? "on" : ""}`} onClick={() => setStateF(st)}>{st}</button>
            ))}
          </div>
          {stateF !== "all" && (
            <span className="sheetnote">Showing what {stateF} needs. Every number on the page is {stateF} only. Quantities are read-only here — switch back to All states to adjust the bake.</span>
          )}
        </div>
      )}

      <div className="dayrow">
        <span className="lbl">Show bake for</span>
        <div className="dayselect">
          <button type="button" className={`daypill week ${isWeek ? "on" : ""}`} onClick={() => setDay("week")}>Whole week</button>
          <span className="daysep" />
          {DOWSHORT.map((d, i) => (
            <button type="button" key={d} className={`daypill ${day === i ? "on" : ""}`} onClick={() => setDay(i)}>
              {d}
              {today === i && <span className="todaytag">today</span>}
            </button>
          ))}
        </div>
        {shape && (
          <span className="daymeas">
            Day bakes measured from real sales — weekends run <b>{shape.weekendLift > 0 ? "+" : ""}{shape.weekendLift}%</b>,
            so the floor makes more heading into Sat/Sun and less on quiet weekdays.
          </span>
        )}
      </div>

      <div className="hero">
        <div>
          <div className="lead">
            {isWeek ? (
              <>
                Right now the factory bakes <b>{nf(totalSent)}</b> items this week. Sized to what actually sells, the plan is <b>{nf(totalEng)}</b>
                {trim > 0 ? <> — <span className="fewer">{nf(trim)} less</span> to bake, so far less comes back at day&apos;s end.</> : <>.</>}
              </>
            ) : (
              <>
                <b>{dayName}{isToday ? " (today)" : ""}</b> — the bakery makes <b>{nf(totalEng)}</b> items, down from <b>{nf(totalSent)}</b> under the old standing order{trim > 0 ? <>, so <span className="fewer">{nf(trim)} less</span> comes back at day&apos;s end</> : <></>}. This is the sheet for the floor.
              </>
            )}
            {/* Same caveat as the Deliveries board. The trim comes entirely from
                the stores whose sales the engine can read; a store with no live
                feed has nothing to size against and keeps its standing volume.
                With Coles dark since 3 Aug that's most of the network, so the
                bake number is a real number over a partial network and the sheet
                should say so rather than let the floor assume otherwise. */}
            {trim > 0 && (
              <span className="carried">
                {" "}The trim comes from the stores whose sales are reaching us. Any store with no feed keeps its
                current volume, so this sheet is never smaller than what those stores already receive.
              </span>
            )}
          </div>
          <div className="babar">
            <div className="eng" style={{ width: `${engPct}%` }}>Bake {nf(totalEng)}</div>
            {trim > 0 ? <div className="trim" style={{ width: `${100 - engPct}%` }}>−{nf(trim)}</div> : null}
          </div>
          <div className="balegend">
            <span><i style={{ background: "var(--green)" }} />What to bake</span>
            <span><i style={{ background: "#ecccbf" }} />Over-bake trimmed</span>
          </div>
        </div>
        <div className="statgrid">
          <div className="s"><div className="n">{nf(totalEng)}</div><div className="l">{isWeek ? "Items to bake / week" : `Items to bake · ${dayShort}`}</div></div>
          <div className="s"><div className="n">{total}</div><div className="l">Product lines</div></div>
          <div className="s"><div className="n g">{nf(Math.max(0, trim))}</div><div className="l">Over-bake trimmed</div></div>
          <div className="s"><div className="n">{doneCount}<span style={{ fontSize: 15, color: "var(--muted)" }}>/{total}</span></div><div className="l">{isWeek ? "Lines confirmed" : "Lines baked"}</div></div>
        </div>
      </div>

      {helpOpen && (
        <div className="help">
          <span className="ic"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 16v-5M12 8h.01" /></svg></span>
          <div><b>How this sheet works:</b> each row is one product. <b>Baking now</b> is the current run. <b>Suggested bake</b> is what to make, sized to real sales. Happy with a line? Tick <b>✓</b>. Disagree? Nudge it with <b>−/+</b>, or reset. Flip to a single day above to hand the floor just that day&apos;s bake.</div>
          <span className="x" onClick={() => setHelpOpen(false)}>✕</span>
        </div>
      )}

      <div className="toolbar">
        <label className="search">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Find a product…" autoComplete="off" />
        </label>
        <button type="button" className={`tgl ${unappOnly ? "on" : ""}`} onClick={() => setUnappOnly((u) => !u)}>{isWeek ? "To confirm only" : "Not baked yet"}</button>
        {editable && <button type="button" className="tgl" onClick={undo} disabled={history.length === 0}>↶ Undo last</button>}
        {editable && <button type="button" className="tgl reset" onClick={resetAll} disabled={!dirty}>↺ Reset</button>}
        <button type="button" className="tgl link" onClick={collapseAll}>{allCollapsed ? "Expand all" : "Collapse all"}</button>
      </div>

      <div className="sheet">
        <div className="colhead"><div className="grid">
          <div>Product</div>
          <div className="r hide">Baking now</div>
          <div className="c">{isWeek ? "Suggested bake" : "Bake today"}</div>
          <div className="r">Difference</div>
          <div className="r hide">Stores</div>
          <div className="c">{isWeek ? "Confirm" : "Baked"}</div>
        </div></div>

        {groups.map((g) => {
          const anyVisible = g.rows.some((l) => rowVisible(l.name));
          if (!anyVisible) return null;
          const isC = !!collapsed[g.category];
          const send = g.rows.reduce((a, l) => a + dv(l.sent), 0);
          const engs = g.rows.reduce((a, l) => a + dv(val(l.name)), 0);
          const fewer = send - engs;
          const color = catColor(g.category);
          return (
            <Fragment key={g.category}>
              <div className={`cathead ${isC ? "collapsed" : ""}`} onClick={() => toggleCat(g.category)}>
                <div className="grid">
                  <div className="cat-name">
                    <span className="acc" style={{ background: color }} />
                    <span className="rn">{g.category}</span>
                    <span className="cnt" style={{ background: `${color}22`, color }}>{g.rows.length}</span>
                    {g.rows.some((l) => isTray(l.name)) && <span className="uompill">by the tray</span>}
                    <button type="button" className="appall" onClick={(e) => { e.stopPropagation(); doneCat(g.category); }}>{isWeek ? "Confirm all" : "Mark all baked"}</button>
                  </div>
                  <div className="cat-send hide">{nf(send)}</div>
                  <div className="cat-eng">{(() => {
                    const t = catTraysFor(g.rows, (n) => dv(val(n)));
                    return t == null ? <>{nf(engs)}</> : <>{nf(t)}<span className="uomsub">trays</span><span className="unitsub">{nf(engs)} items</span></>;
                  })()}</div>
                  <div className="cat-chg">{catChg(fewer)}</div>
                  <div className="hide" />
                  <div className="cat-chev"><svg className="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></svg></div>
                </div>
              </div>
              {!isC && g.rows.map((l) => {
                if (!rowVisible(l.name)) return null;
                const v = val(l.name);
                const changed = v !== orig[l.name];
                const done = isDone(l.name);
                return (
                  <div key={l.name} className={`row ${done ? "approved" : ""} ${isWeek && changed ? "edited" : ""}`}>
                    <div className="grid">
                      <div className="pname">{l.name}</div>
                      <div className="sendnow hide">{nf(dv(l.sent))}</div>
                      {editable ? (
                        <div className="engcell">
                          {traysFor(dv(v), l.name) != null && (
                            <div className="traylead">{nf(traysFor(dv(v), l.name)!)} {traysFor(dv(v), l.name) === 1 ? "tray" : "trays"}</div>
                          )}
                          <div className="stepper">
                            <button type="button" aria-label={`decrease ${l.name}`} onClick={() => setEngine(l.name, v - 1)}>−</button>
                            <input
                              className={changed ? "edited" : ""}
                              value={v}
                              inputMode="numeric"
                              onChange={(e) => setEngine(l.name, parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}
                              onFocus={(e) => e.currentTarget.select()}
                            />
                            <button type="button" aria-label={`increase ${l.name}`} onClick={() => setEngine(l.name, v + 1)}>+</button>
                          </div>
                          {traysFor(dv(v), l.name) != null && <div className="unitsub">items</div>}
                        </div>
                      ) : (
                        <div className="engcell"><div className="engnum">{qtyCell(dv(v), l.name)}</div></div>
                      )}
                      <div className="chg">
                        {editable && changed && (
                          <button type="button" className="rst" title={`Reset to ${orig[l.name]}`} onClick={() => resetRow(l.name)}>
                            <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" /></svg>
                          </button>
                        )}
                        {chgPill(l)}
                      </div>
                      <div className="stores hide">{l.stores}</div>
                      <div className="appcell">
                        <button type="button" className={`appbtn ${done ? "on" : ""}`} aria-label={`${isWeek ? "confirm" : "baked"} ${l.name}`} onClick={() => toggleDone(l.name)}>
                          <svg viewBox="0 0 24 24"><path d="M5 12l5 5 10-11" /></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      <div className="foot">
        {isWeek ? (
          <>Calm by default — the −/+ controls appear when you hover a row, and the number reads like plain text until you go to change it. Switch to a day above to see just that day&apos;s bake for the floor. <b>Your line confirmations save and stay across reloads;</b> the −/+ quantity nudges are a working draft, and printing &amp; locking the sheet for the floor is the next build phase. Daily splits are {shape ? "sized from the measured weekday shape" : "modelled from typical day-of-week demand"} until the daily plan is wired — the weekly totals are exact. <b>Bagels and mini challah are counted by the tray</b>, the way Jesse&apos;s own sheet reads, with the unit total underneath. Tray sizes come from Jesse&apos;s product list — 24 to a tray for bagels, 40 for mini bagels, 20 for mini challah — so each line converts on its own rather than one number standing for a whole category.</>
        ) : (
          <><b>{dayName}&apos;s</b> share of the week&apos;s plan — read-only. Tick each line as it&apos;s baked, or export the sheet for the bench. To change quantities, switch back to <b>Whole week</b>. This day&apos;s split is {shape ? "sized from the measured weekday shape" : "modelled from typical demand"} until the daily plan is wired.</>
        )}
      </div>

      <div className="actionbar">
        <div className="prog"><b>{doneCount}</b> of {total} lines {isWeek ? "confirmed" : "baked"} · baking <span className="tr">{nf(totalEng)}</span> items {isWeek ? "this week" : dayShort}</div>
        <div className="sp">
          <button type="button" className="btn" onClick={exportBakeSheet}>↧ {isWeek ? "Export bake sheet" : `Export ${dayShort} sheet`}</button>
          <button type="button" className="btn primary" onClick={() => {
            if (isWeek) { const next = Object.fromEntries(lines.map((l) => [l.name, true])); setApproved(next); persistApproved(next); showToast(`All ${total} lines confirmed ✓ — saved`); }
            else { setBaked((b) => ({ ...b, [String(day)]: Object.fromEntries(lines.map((l) => [l.name, true])) })); showToast(`All lines marked baked for ${dayShort} ✓`); }
          }}>✓ {isWeek ? "Confirm all" : "Mark all baked"}</button>
        </div>
      </div>

      {toast && <div className="toast"><span>{toast}</span></div>}

      <style>{`
      .pcalm{display:block;padding-bottom:72px}
      .pcalm .dayrow{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
      .pcalm .dayrow .lbl{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.2px}
      .pcalm .daymeas{flex-basis:100%;font-size:12px;color:var(--muted);line-height:1.5}
      .pcalm .daymeas b{color:var(--ink);font-weight:700}
      .pcalm .dayselect{display:flex;gap:4px;background:#ece3d1;border-radius:11px;padding:4px;flex-wrap:wrap}
      .pcalm .daypill{border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);padding:8px 14px;border-radius:8px;cursor:pointer;transition:.14s}
      .pcalm .daypill:hover{color:var(--ink2)}
      .pcalm .daypill.on{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(60,45,30,.16)}
      .pcalm .daypill.week.on{color:var(--crust-deep)}
      .pcalm .daysep{width:1px;height:22px;background:#d8ccb2;margin:0 2px}
      .pcalm .todaytag{font-size:10px;font-weight:700;color:var(--green-t);background:var(--green-b);border-radius:5px;padding:1px 5px;margin-left:5px;vertical-align:1px}
      .pcalm .hero{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:22px 26px;margin-bottom:16px;display:grid;grid-template-columns:1.5fr 1fr;gap:30px;align-items:center}
      @media(max-width:960px){.pcalm .hero{grid-template-columns:1fr;gap:22px}}
      .pcalm .lead{font-size:15.5px;line-height:1.5}
      .pcalm .carried{display:block;margin-top:6px;font-size:13px;color:var(--muted)}
      .pcalm .lead b{font-weight:700}
      .pcalm .fewer{color:var(--green-t);font-weight:700}
      .pcalm .babar{margin-top:16px;height:24px;border-radius:8px;overflow:hidden;display:flex;background:#f0e9db;box-shadow:inset 0 0 0 1px var(--line2)}
      .pcalm .babar .eng{background:linear-gradient(90deg,#6f9c67,#5f8f5a);display:flex;align-items:center;padding-left:12px;color:#fff;font-size:12px;font-weight:700;white-space:nowrap;transition:width .5s}
      .pcalm .babar .trim{background:repeating-linear-gradient(45deg,#f3dbd1,#f3dbd1 6px,#efd2c6 6px,#efd2c6 12px);display:flex;align-items:center;justify-content:flex-end;padding-right:12px;color:var(--red-t);font-size:12px;font-weight:700;white-space:nowrap;transition:width .5s}
      .pcalm .balegend{display:flex;gap:18px;margin-top:10px;font-size:11.5px;color:var(--muted)}
      .pcalm .balegend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
      .pcalm .statgrid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:12px;overflow:hidden}
      .pcalm .statgrid .s{background:var(--card);padding:14px 16px}
      .pcalm .statgrid .s .n{font-family:var(--serif);font-size:25px;font-weight:600;letter-spacing:-.5px;font-variant-numeric:tabular-nums;line-height:1}
      .pcalm .statgrid .s .l{font-size:11px;color:var(--muted);margin-top:6px}
      .pcalm .statgrid .s .n.g{color:var(--green-t)}
      .pcalm .help{display:flex;align-items:flex-start;gap:12px;background:linear-gradient(135deg,#fffdf8,#fbf5e8);border:1px solid var(--line);border-radius:12px;padding:13px 16px;margin-bottom:14px;font-size:13px;line-height:1.55;color:var(--ink2)}
      .pcalm .help .ic{width:26px;height:26px;border-radius:7px;background:var(--amber-b);display:flex;align-items:center;justify-content:center;flex:none}
      .pcalm .help .ic svg{width:15px;height:15px;stroke:var(--amber-t);stroke-width:2;fill:none}
      .pcalm .help b{color:var(--ink);font-weight:600}
      .pcalm .help .x{margin-left:auto;color:var(--faint);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;flex:none}
      .pcalm .help .x:hover{color:var(--ink2)}
      .pcalm .toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
      .pcalm .search{flex:1;min-width:200px;display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:0 12px;box-shadow:var(--sh)}
      .pcalm .search:focus-within{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .pcalm .search svg{width:16px;height:16px;stroke:var(--muted);stroke-width:1.9;fill:none}
      .pcalm .search input{flex:1;border:none;background:transparent;padding:11px 2px;font-size:14px;font-family:inherit;outline:none}
      .pcalm .tgl{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:10px 15px;font-size:13px;font-weight:600;cursor:pointer;color:var(--ink2);box-shadow:var(--sh);font-family:inherit;display:inline-flex;align-items:center;gap:7px}
      .pcalm .tgl:hover{background:#f6f0e6}
      .pcalm .tgl.on{background:var(--espresso);border-color:var(--espresso);color:#f4ecdc}
      .pcalm .tgl:disabled{opacity:.4;cursor:default;background:var(--card)}
      .pcalm .tgl.link{background:transparent;border-color:transparent;box-shadow:none;color:var(--crust-deep)}
      .pcalm .tgl.reset:not(:disabled){background:#fdf6e7;border-color:var(--amber);color:var(--amber-t)}
      .pcalm .tgl.reset:not(:disabled):hover{background:#fbeed2}
      .pcalm .sheet{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh)}
      .pcalm .grid{display:grid;grid-template-columns:minmax(190px,1fr) 116px 150px 104px 72px 108px;align-items:center}
      .pcalm .colhead{background:var(--surface);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;border-top-left-radius:var(--r);border-top-right-radius:var(--r)}
      .pcalm .sheet>:last-child{border-bottom-left-radius:var(--r);border-bottom-right-radius:var(--r)}
      .pcalm .colhead .grid>div{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:12px 18px}
      .pcalm .colhead .r{text-align:right}.pcalm .colhead .c{text-align:center}
      .pcalm .colhead .grid>div:last-child{padding-right:24px}
      .pcalm .colhead + .cathead{border-top:none}
      .pcalm .cathead{border-top:1px solid var(--line);cursor:pointer;background:#faf6ee}
      .pcalm .cathead>.grid>div{padding:11px 18px}
      .pcalm .cat-name{display:flex;align-items:center;gap:11px}
      .pcalm .cathead .acc{width:5px;height:22px;border-radius:4px;flex:none}
      .pcalm .cathead .rn{font-family:var(--serif);font-size:15.5px;font-weight:600;letter-spacing:-.2px}
      .pcalm .cathead .cnt{border-radius:999px;font-size:11px;font-weight:700;padding:2px 9px}
      .pcalm .uompill{font-size:10px;font-weight:700;letter-spacing:.3px;color:var(--crust-deep);background:#f3e6cf;border:1px solid #e6d3ad;border-radius:999px;padding:2px 9px;text-transform:uppercase;white-space:nowrap}
      .pcalm .uomsub{font-size:10.5px;font-weight:700;letter-spacing:.3px;color:var(--crust-deep);text-transform:uppercase;margin-left:4px}
      .pcalm .unitsub{display:block;font-size:11px;font-weight:600;color:var(--muted);margin-top:2px;font-variant-numeric:tabular-nums}
      .pcalm .traylead{text-align:center;font-size:13px;font-weight:700;color:var(--crust-deep);margin-bottom:3px;font-variant-numeric:tabular-nums}
      .pcalm .sheetrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
      .pcalm .sheetselect{display:inline-flex;gap:4px;background:#f6efe2;border:1px solid #e6d3ad;border-radius:999px;padding:3px}
      .pcalm .sheetpill{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;border-radius:999px;padding:5px 14px;font-size:13px;font-weight:600;color:var(--ink2);cursor:pointer}
      .pcalm .sheetpill.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
      .pcalm .sheetpill .cnt{font-size:11px;font-weight:700;color:var(--crust-deep);background:#efe0c4;border-radius:999px;padding:1px 7px}
      .pcalm .sheetnote{font-size:12px;color:var(--muted);max-width:520px;line-height:1.5}
      .pcalm .cat-send{text-align:right;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
      .pcalm .cat-eng{text-align:center;color:var(--ink);font-weight:700;font-size:14px;font-variant-numeric:tabular-nums}
      .pcalm .cat-chg{text-align:right;color:var(--crust-deep);font-weight:700;font-size:13px;font-variant-numeric:tabular-nums}
      .pcalm .cat-chev{display:flex;justify-content:center;padding-right:20px !important}
      .pcalm .cathead .chev{width:15px;height:15px;stroke:var(--muted);stroke-width:2.2;fill:none;transition:transform .2s;flex:none}
      .pcalm .cathead.collapsed .chev{transform:rotate(-90deg)}
      .pcalm .cathead .appall{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;opacity:0;transition:.14s;margin-left:4px}
      .pcalm .cathead:hover .appall{opacity:1}
      .pcalm .row{border-top:1px solid var(--line2);transition:background .12s}
      .pcalm .row:hover{background:#faf6ee}
      .pcalm .row.approved{background:#f4f8f1}
      .pcalm .row>.grid>div{padding:12px 18px}
      .pcalm .pname{font-weight:600;letter-spacing:-.1px}
      .pcalm .sendnow{text-align:right;font-variant-numeric:tabular-nums;color:var(--faint)}
      .pcalm .engcell{padding-left:18px !important;padding-right:18px !important}
      .pcalm .engnum{text-align:center;font-weight:700;font-size:15px;font-variant-numeric:tabular-nums}
      .pcalm .stepper{display:flex;align-items:center;justify-content:center;gap:6px}
      .pcalm .stepper button{width:26px;height:26px;border:1px solid var(--line);background:var(--card);border-radius:7px;font-size:15px;line-height:1;cursor:pointer;color:var(--ink2);font-family:inherit;display:flex;align-items:center;justify-content:center;transition:.12s;opacity:0}
      .pcalm .stepper button:hover{background:#f3ecdd;border-color:var(--crust)}
      .pcalm .row:hover .stepper button,.pcalm .engcell:focus-within .stepper button{opacity:1}
      /* 76px, not 56. box-sizing is border-box (globals.css:30), so 56 left
         38px of text after padding and borders -- four digits of 15px bold
         numerals is about 36, which is why 3132 looked shaved. Tommy pointed
         at it on the 1 Sept call. Five digits now fits. */
      .pcalm .stepper input{width:76px;text-align:center;border:1px solid transparent;border-radius:7px;padding:6px 8px;font-size:15px;font-weight:700;font-family:inherit;font-variant-numeric:tabular-nums;color:var(--ink);background:transparent;outline:none;transition:.12s;cursor:pointer}
      .pcalm .row:hover .stepper input{border-color:var(--line);background:var(--surface)}
      .pcalm .stepper input:focus{border-color:var(--crust);background:#fff;box-shadow:0 0 0 3px rgba(176,116,28,.13);cursor:text}
      .pcalm .stepper input.edited{border-color:var(--amber);background:#fdf6e7;box-shadow:0 0 0 2px rgba(198,138,46,.14)}
      .pcalm .chg{display:flex;align-items:center;justify-content:flex-end;gap:8px}
      .pcalm .rst{width:22px;height:22px;border:1px solid var(--line);background:var(--card);border-radius:6px;cursor:pointer;color:var(--crust-deep);display:flex;align-items:center;justify-content:center;flex:none;font-family:inherit;padding:0}
      .pcalm .rst svg{width:13px;height:13px;stroke:currentColor;stroke-width:2;fill:none}
      .pcalm .rst:hover{background:#f7ede0;border-color:var(--crust)}
      .pcalm .chgpill{font-weight:600;font-size:13px;font-variant-numeric:tabular-nums;color:var(--green-t)}
      .pcalm .chgpill.add{color:var(--amber-t)}
      .pcalm .chgpill.same{color:var(--faint)}
      .pcalm .stores{text-align:right;font-variant-numeric:tabular-nums;color:var(--faint);font-size:13px}
      .pcalm .appcell{display:flex;justify-content:center;padding-right:20px !important}
      .pcalm .appbtn{width:28px;height:28px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.14s;padding:0}
      .pcalm .appbtn svg{width:15px;height:15px;stroke:var(--faint);stroke-width:2.4;fill:none;transition:.14s}
      .pcalm .appbtn:hover{border-color:var(--green)}
      .pcalm .appbtn.on{background:var(--green);border-color:var(--green)}
      .pcalm .appbtn.on svg{stroke:#fff}
      .pcalm .foot{margin-top:24px;font-size:11.5px;color:var(--faint);line-height:1.6}
      .pcalm .foot b{color:var(--ink2);font-weight:600}
      .pcalm .actionbar{position:fixed;left:236px;right:0;bottom:0;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-top:1px solid var(--line);box-shadow:0 -6px 20px -12px rgba(60,45,30,.25);padding:12px clamp(18px,3.4vw,60px);display:flex;align-items:center;gap:16px;z-index:30;flex-wrap:wrap}
      .pcalm .actionbar .prog{font-size:13.5px;color:var(--ink2)}
      .pcalm .actionbar .prog b{font-weight:700}
      .pcalm .actionbar .prog .tr{color:var(--green-t);font-weight:700}
      .pcalm .actionbar .sp{margin-left:auto;display:flex;gap:10px}
      .pcalm .btn{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 18px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink);display:inline-flex;align-items:center;gap:8px}
      .pcalm .btn:hover{background:#f6f0e6}
      .pcalm .btn.primary{background:var(--espresso);border-color:var(--espresso);color:#f4ecdc}
      .pcalm .btn.primary:hover{background:#392b20}
      .pcalm .toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13.5px;font-weight:500;z-index:60;display:flex;gap:10px;align-items:center;max-width:88vw}
      @media(max-width:900px){.pcalm .actionbar{left:0}}
      @media(max-width:820px){.pcalm .grid{grid-template-columns:minmax(150px,1fr) 150px 96px 60px}.pcalm .colhead .hide,.pcalm .row .hide,.pcalm .cathead .hide{display:none}}
      @media(max-width:720px){.pcalm .stepper button{opacity:1}}
      `}</style>
    </section>
  );
}
