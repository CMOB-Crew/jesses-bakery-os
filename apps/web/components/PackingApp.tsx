"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PackRun } from "@/lib/queries";

// Packing app — the iPad view AND the printed packing slip, on live data.
//
// ---------------------------------------------------------------------
// WHAT CHANGED, 28 AUG
// ---------------------------------------------------------------------
// This was a prototype with eleven invented stores hardcoded at the top of the
// file. It now reads the real plan for a real day.
//
// The reason it was worth doing six days out is the print slip further down:
// it was already complete — every store, every item, tick boxes, a
// packed-by/checked-by line, page-break handling. It just printed fictional
// stores. Feeding it the real plan turns "Export PDF" into the packing sheet
// the bakery actually packs from, which is useful on day one whether or not a
// single packer has a login yet.
//
// ---------------------------------------------------------------------
// WHY IT READS A DAY AND NOT A WEEK
// ---------------------------------------------------------------------
// Every other board in this app reads store_reco, which is a CURRENT-WEEK
// total. A packing slip is one day. Packing off store_reco would have
// overstated every number on the sheet by roughly the number of delivery days
// in the week — a mistake that looks fine on screen right up until someone
// bakes it. getPackingRuns reads replenishment_plans by target_date instead.
//
// ---------------------------------------------------------------------
// STILL NOT WIRED, AND SAID SO ON SCREEN
// ---------------------------------------------------------------------
// Ticks and flags live in this component for the session. Finalise shows a
// toast and sends nothing to drivers. Both are honest in the banner rather
// than implied to work.
// ---------------------------------------------------------------------

type SStatus = "pending" | "packed" | "flagged";
type UIStore = { store_id: string; name: string; retailer: string; items: [string, number][]; units: number; status: SStatus; comment: string };
type UIRun = { run_id: string; name: string; stores: UIStore[]; units: number };

const CHIPS = ["Short on the order", "Item damaged", "Substituted product", "Out of stock — nothing to pack"];
const CHIP_LABEL: Record<string, string> = { "Short on the order": "Short", "Item damaged": "Damaged", "Substituted product": "Substituted", "Out of stock — nothing to pack": "Out of stock" };

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function toUI(runs: PackRun[]): UIRun[] {
  return runs.map((r) => ({
    run_id: r.run_id,
    name: r.name,
    units: r.units,
    stores: r.stores.map((s) => ({
      store_id: s.store_id,
      name: s.name,
      retailer: s.retailer,
      items: s.items.map((i) => [i.name, i.qty] as [string, number]),
      units: s.units,
      status: "pending" as SStatus,
      comment: "",
    })),
  }));
}

export default function PackingApp({
  runs: runsIn,
  day,
  dayLabel,
  days,
  who,
}: {
  runs: PackRun[];
  day: string;
  dayLabel: string;
  days: { value: string; label: string }[];
  who: string;
}) {
  const router = useRouter();
  // Keyed by day so switching days starts a clean sheet rather than carrying
  // yesterday's ticks onto today's stores.
  const [runs, setRuns] = useState<UIRun[]>(() => toUI(runsIn));
  // Which stores are on a standing order rather than a plan. Read straight off
  // the server rows by id, so neither UIStore nor toUI has to change.
  const standingIds = useMemo(
    () => new Set(runsIn.flatMap((r) => r.stores.filter((s) => s.standing).map((s) => s.store_id))),
    [runsIn],
  );
  const standingCount = standingIds.size;
  const [cur, setCur] = useState(0);
  const [expItems, setExpItems] = useState<Record<string, boolean>>({});
  const [flagOpen, setFlagOpen] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = runs[cur];
  const key = (si: number) => `${cur}:${si}`;
  const packed = (r: UIRun) => r.stores.filter((s) => s.status !== "pending").length;

  const runsMeta = useMemo(() => runs.map((r) => ({ p: packed(r), n: r.stores.length })), [runs]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }

  function mutate(si: number, fn: (s: UIStore) => UIStore) {
    setRuns((rs) => rs.map((r, ri) => (ri !== cur ? r : { ...r, stores: r.stores.map((s, i) => (i === si ? fn(s) : s)) })));
  }
  function togglePack(si: number) {
    mutate(si, (s) => ({ ...s, status: s.status === "packed" ? "pending" : "packed", comment: "" }));
    setFlagOpen((f) => ({ ...f, [key(si)]: false }));
  }
  function saveFlag(si: number) {
    const reason = (draft[key(si)] || "").trim();
    if (!reason) return;
    mutate(si, (s) => ({ ...s, status: "flagged", comment: reason }));
    setFlagOpen((f) => ({ ...f, [key(si)]: false }));
  }

  // Nothing is planned for this day. Real state, not an error — Sundays run a
  // short sheet and a day past the plan's last date has none at all.
  if (!run) {
    return (
      <div className="packwrap">
        <div className="panel" style={{ maxWidth: 620 }}>
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Nothing to pack on {dayLabel}</div>
          <div style={{ color: "var(--ink2)", lineHeight: 1.6, marginBottom: 14 }}>
            No run delivers on this day, or the plan does not reach it yet. The engine plans twelve days ahead and rewrites them nightly.
          </div>
          <DayPicker day={day} days={days} onPick={(d) => router.push(`/packing?day=${d}`)} />
        </div>
      </div>
    );
  }

  const curPacked = runsMeta[cur].p;
  const allDone = curPacked === run.stores.length;
  const totalUnits = runs.reduce((a, r) => a + r.units, 0);
  const totalStores = runs.reduce((a, r) => a + r.stores.length, 0);

  return (
    <div className="packwrap">
      <div className="livenote">
        <b>Live plan.</b> These are the real stores and real quantities for {dayLabel} — {totalStores} stores across {runs.length} runs, {totalUnits.toLocaleString("en-AU")} units.
        {standingCount > 0 && (
          <> <b>{standingCount}</b> of those {standingCount === 1 ? "is" : "are"} on their <b>standing order</b>, not a forecast — their
          sales feed is too far behind for the plan to size them, so what is going out today is shown and marked.</>
        )}{" "}
        Ticks and flags are kept for this session only and are not saved yet, and <b>Finalise</b> does not send anything to the drivers. <b>Export PDF</b> prints the real slip.
      </div>
      <div className="cap">
        Packing · iPad view. Big tick-off targets, a mandatory comment on any discrepancy, and every action stamped to the packer — the accountability the current PDF slips don&apos;t have.
      </div>
      <div className="pad"><div className="app">
        <div className="top">
          <span className="logo"><span className="mk">✦</span> Jesse&apos;s Bakery</span><h1>Packing</h1>
          <DayPicker day={day} days={days} onPick={(d) => router.push(`/packing?day=${d}`)} />
          <button className="pexport no-print" onClick={() => window.print()} title={`Print the ${run.name} run as a packing slip`}>⤓ Export PDF</button>
          <span className="who"><span className="av">{who.trim().charAt(0).toUpperCase() || "?"}</span>{who}</span>
        </div>
        <div className="body">
          <div className="runs">
            <div className="h">Runs on {dayLabel}</div>
            {runs.map((r, i) => {
              const { p, n } = runsMeta[i];
              const done = p === n;
              return (
                <div key={r.run_id || r.name} className={`run ${i === cur ? "on" : ""}`} onClick={() => setCur(i)}>
                  <div className="rn">{r.name}<span className="cdot" style={{ background: done ? "var(--green)" : "var(--crust)" }} /></div>
                  <div className="rd">{plural(r.stores.length, "store")} · {r.units.toLocaleString("en-AU")} units</div>
                  <div className="track"><i style={{ width: `${(100 * p) / Math.max(1, n)}%` }} /></div>
                  <div className="rc">{p} of {n} packed</div>
                </div>
              );
            })}
          </div>

          <div className="main">
            <div className="mh"><h2>{run.name}</h2><span className="ms">{plural(run.stores.length, "store")} · {run.units.toLocaleString("en-AU")} units</span></div>
            <div className="list">
              {run.stores.map((s, si) => {
                const itemsShown = !!expItems[key(si)];
                const flagShown = !!flagOpen[key(si)];
                const reason = draft[key(si)] || "";
                return (
                  <div key={s.store_id} className={`srow ${s.status}`}>
                    <div className="srhead">
                      <div className="check" onClick={() => togglePack(si)}>✓</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="nm">{s.name}</div>
                        <div className="it">{s.units} items · {s.items.length} products {standingIds.has(s.store_id) && <span className="tag amber" title="No sales feed to size this store — this is its current standing order, not a forecast.">standing order</span>} {s.status === "flagged" && <span className="tag amber">⚑ flagged</span>}</div>
                        {s.status === "flagged" && <div className="cmt">⚑ {s.comment}</div>}
                      </div>
                      <button className="exp" onClick={() => setExpItems((e) => ({ ...e, [key(si)]: !e[key(si)] }))}>{itemsShown ? "hide items" : "view items"}</button>
                    </div>
                    {itemsShown && (
                      <div className="items">
                        {s.items.map((i) => <span className="iq" key={i[0]}>{i[0]} <b>{i[1]}</b></span>)}
                      </div>
                    )}
                    {flagShown && (
                      <div className="flagpanel">
                        <div className="fh">What&apos;s the issue? (a comment is required to pass an unpacked store)</div>
                        <div className="chips">
                          {CHIPS.map((c) => <span key={c} className={`chip ${reason === c ? "on" : ""}`} onClick={() => setDraft((d) => ({ ...d, [key(si)]: c }))}>{CHIP_LABEL[c]}</span>)}
                        </div>
                        <input value={CHIPS.includes(reason) ? "" : reason} placeholder="Or type a note…" onChange={(e) => setDraft((d) => ({ ...d, [key(si)]: e.target.value }))} />
                        <button className="btn amber sm" disabled={!reason.trim()} onClick={() => saveFlag(si)}>Save flag</button>
                        <button className="btn sm" onClick={() => setFlagOpen((f) => ({ ...f, [key(si)]: false }))}>Cancel</button>
                      </div>
                    )}
                    {s.status === "pending" && !flagShown && (
                      <div style={{ marginTop: 10 }}>
                        <button className="exp amber" onClick={() => setFlagOpen((f) => ({ ...f, [key(si)]: true }))}>⚑ Flag an issue instead</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="foot">
              <span className="st">{allDone ? `All ${run.stores.length} stores resolved — ready to finalise.` : `${plural(run.stores.length - curPacked, "store")} still to pack or flag.`}</span>
              <button className="final" disabled={!allDone} onClick={() => showToast(`${run.name} marked finalised by ${who}. Not saved and not sent to drivers yet — that is the next phase.`)}>
                {allDone ? `Finalise ${run.name}` : "Finalise run"}
              </button>
            </div>
          </div>
        </div>
      </div></div>

      {/* Print-only packing slip for the current run — this is what "Export PDF"
          produces (browser print → Save as PDF). Every store's full item list
          with tick boxes and a sign-off line; the interactive iPad view is hidden
          on paper. Real stores and real quantities since 28 Aug. */}
      <div className="pack-slip" aria-hidden="true">
        <div className="ps-head">
          <div className="ps-brand"><span className="mk">✦</span> Jesse&apos;s Bakery — Packing Slip</div>
          <div className="ps-meta">{run.name} · {dayLabel} · {plural(run.stores.length, "store")} · {run.units.toLocaleString("en-AU")} units</div>
          <div className="ps-date">Packer: __________________   Checked by: __________________</div>
        </div>
        {run.stores.map((s) => (
          <div className="ps-store" key={s.store_id}>
            <div className="ps-sh"><span className="ps-box" /><span className="ps-name">{s.name}</span><span className="ps-tot">{s.units} items · {s.items.length} products</span></div>
            <table className="ps-items"><tbody>
              {s.items.map((it) => (
                <tr key={it[0]}><td className="ps-p">{it[0]}</td><td className="ps-q">{it[1]}</td><td className="ps-c">☐ packed</td></tr>
              ))}
            </tbody></table>
          </div>
        ))}
        <div className="ps-sign">Packed by ____________________     Checked by ____________________     Time __________</div>
      </div>

      {toast && <div className="packtoast">{toast}</div>}

      <style>{`
      .packwrap{display:flex;flex-direction:column;align-items:center;padding:6px 0 30px}
      .packwrap .livenote{background:var(--amber-b);border:1px solid #ecdcbb;color:var(--amber-t);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:12.5px;line-height:1.55;max-width:900px}
      .packwrap .cap{font-size:12.5px;color:var(--muted);margin-bottom:12px;text-align:center;max-width:760px;line-height:1.5}
      .packwrap .pad{width:1120px;max-width:100%;height:760px;background:#151009;border-radius:30px;padding:14px;box-shadow:0 30px 70px -22px rgba(40,25,10,.5)}
      .packwrap .app{background:var(--paper);border-radius:18px;height:100%;overflow:hidden;display:flex;flex-direction:column}
      .packwrap .top{padding:16px 22px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line)}
      .packwrap .top .logo{font-family:var(--serif);font-weight:600;font-size:18px}
      .packwrap .top .logo .mk{color:var(--crust)}
      .packwrap .top h1{font-family:var(--serif);font-size:20px;font-weight:600;margin-left:6px}
      .packwrap .daypick{font-family:inherit;font-size:13px;font-weight:600;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:7px 10px;cursor:pointer}
      .packwrap .daypick:focus{outline:none;border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .packwrap .top .who{margin-left:auto;display:flex;align-items:center;gap:9px;background:var(--surface);border:1px solid var(--line);padding:6px 12px 6px 6px;border-radius:999px;font-size:13px;font-weight:600;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .packwrap .top .who .av{width:28px;height:28px;border-radius:50%;background:var(--espresso);color:#f0e6d2;display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-size:13px;flex:none}
      .packwrap .body{flex:1;display:flex;min-height:0}
      .packwrap .runs{width:296px;border-right:1px solid var(--line);padding:16px;overflow:auto;flex:none}
      .packwrap .runs .h{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:10px}
      .packwrap .run{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px;margin-bottom:10px;cursor:pointer;transition:.15s;box-shadow:0 1px 2px rgba(60,45,30,.05)}
      .packwrap .run.on{border-color:var(--crust);box-shadow:0 0 0 2px rgba(176,116,28,.18)}
      .packwrap .run .rn{font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px}
      .packwrap .run .rd{font-size:12px;color:var(--muted);margin:2px 0 8px}
      .packwrap .run .track{height:7px;background:#e7ddca;border-radius:5px;overflow:hidden}
      .packwrap .run .track i{display:block;height:100%;background:var(--crust);border-radius:5px}
      .packwrap .run .rc{font-size:11.5px;color:var(--ink2);margin-top:6px;font-weight:600}
      .packwrap .run .cdot{width:8px;height:8px;border-radius:50%;margin-left:auto}
      .packwrap .main{flex:1;display:flex;flex-direction:column;min-width:0}
      .packwrap .mh{padding:18px 24px 6px;display:flex;align-items:baseline;gap:12px}
      .packwrap .mh h2{font-family:var(--serif);font-size:24px;font-weight:600;letter-spacing:-.4px}
      .packwrap .mh .ms{font-size:13px;color:var(--muted)}
      .packwrap .list{flex:1;overflow:auto;padding:8px 24px 8px}
      .packwrap .srow{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px;box-shadow:0 1px 2px rgba(60,45,30,.05)}
      .packwrap .srow.packed{background:#f4f8f2;border-color:#d7e6cf}
      .packwrap .srow.flagged{background:#fbf4e6;border-color:#ecdcbb}
      .packwrap .srhead{display:flex;align-items:center;gap:14px}
      .packwrap .check{width:40px;height:40px;border-radius:11px;border:2px solid var(--line);background:var(--card);cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;font-size:22px;color:transparent;transition:.15s}
      .packwrap .srow.packed .check{background:var(--green);border-color:var(--green);color:#fff}
      .packwrap .srow.flagged .check{background:var(--amber);border-color:var(--amber);color:#fff}
      .packwrap .srhead .nm{font-weight:600;font-size:15.5px}
      .packwrap .srhead .it{font-size:12.5px;color:var(--muted);margin-top:1px;display:flex;align-items:center;gap:6px}
      .packwrap .srhead .exp{margin-left:auto;font-size:12.5px;color:var(--crust-deep);font-weight:600;cursor:pointer;background:none;border:none;font-family:inherit;flex:none}
      .packwrap .srhead .exp.amber{color:var(--amber-t)}
      .packwrap .exp.amber{color:var(--amber-t);background:none;border:none;font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
      .packwrap .cmt{font-size:12.5px;color:var(--amber-t);font-weight:600;margin-top:6px}
      .packwrap .items{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line2)}
      .packwrap .iq{background:var(--surface);border:1px solid var(--line2);border-radius:999px;padding:4px 11px;font-size:12.5px}
      .packwrap .iq b{font-variant-numeric:tabular-nums;color:var(--ink)}
      .packwrap .flagpanel{margin-top:12px;padding-top:12px;border-top:1px solid var(--line2)}
      .packwrap .flagpanel .fh{font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:8px}
      .packwrap .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
      .packwrap .chip{background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:8px 13px;font-size:13px;cursor:pointer;font-weight:500}
      .packwrap .chip.on{background:var(--amber);border-color:var(--amber);color:#fff}
      .packwrap .flagpanel input{width:100%;border:1px solid var(--line);border-radius:9px;padding:9px 12px;font-size:13.5px;font-family:inherit;background:var(--surface);outline:none;margin-bottom:10px}
      .packwrap .flagpanel input:focus{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .packwrap .btn{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:9px 15px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink)}
      .packwrap .btn.sm{padding:7px 13px;font-size:12.5px}
      .packwrap .btn.amber{background:var(--amber);border-color:var(--amber);color:#fff}
      .packwrap .btn:disabled{opacity:.5;cursor:not-allowed}
      .packwrap .foot{padding:14px 24px;border-top:1px solid var(--line);display:flex;align-items:center;gap:14px;background:var(--paper)}
      .packwrap .foot .st{font-size:13px;color:var(--ink2)}
      .packwrap .final{margin-left:auto;padding:12px 22px;border:none;border-radius:12px;font-family:inherit;font-weight:700;font-size:14.5px;cursor:pointer;background:var(--espresso);color:#fff}
      .packwrap .final:disabled{background:#d9cfbb;color:#9a8f7c;cursor:not-allowed}
      .packwrap .tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px}
      .packwrap .tag.amber{background:var(--amber-b);color:var(--amber-t)}
      .packwrap .packtoast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13.5px;font-weight:500;z-index:60;max-width:88vw;text-align:center}
      @media(max-width:900px){.packwrap .runs{width:220px}}

      /* Export PDF button */
      .packwrap .pexport{display:inline-flex;align-items:center;gap:6px;background:var(--espresso);color:#f4ecd9;border:0;border-radius:999px;padding:8px 16px;font:600 13px inherit;cursor:pointer}
      .packwrap .pexport:hover{background:#3a2a17}

      /* Print-only packing slip — hidden on screen, shown on paper/PDF */
      .packwrap .pack-slip{display:none}
      @media print{
        .packwrap .pad{display:none !important}
        .packwrap .cap, .packwrap .livenote{display:none !important}
        .packwrap .pack-slip{display:block;color:#000}
        .packwrap .ps-head{border-bottom:2px solid #000;padding-bottom:10px;margin-bottom:14px}
        .packwrap .ps-brand{font-family:var(--serif);font-size:22px;font-weight:700}
        .packwrap .ps-brand .mk{color:#000}
        .packwrap .ps-meta{font-size:14px;font-weight:600;margin-top:4px}
        .packwrap .ps-date{font-size:12.5px;margin-top:8px;color:#333}
        .packwrap .ps-store{break-inside:avoid;margin-bottom:14px}
        .packwrap .ps-sh{display:flex;align-items:center;gap:10px;border-bottom:1px solid #999;padding-bottom:4px;margin-bottom:4px}
        .packwrap .ps-box{width:16px;height:16px;border:1.5px solid #000;border-radius:3px;flex:none}
        .packwrap .ps-name{font-size:15px;font-weight:700}
        .packwrap .ps-tot{margin-left:auto;font-size:11.5px;color:#444}
        .packwrap .ps-items{width:100%;border-collapse:collapse;font-size:12.5px}
        .packwrap .ps-items td{padding:2px 4px;border-bottom:1px dotted #ccc}
        .packwrap .ps-q{text-align:right;font-weight:700;width:48px;font-variant-numeric:tabular-nums}
        .packwrap .ps-c{text-align:right;width:88px;color:#555}
        .packwrap .ps-sign{margin-top:22px;padding-top:10px;border-top:2px solid #000;font-size:12.5px}
        @page{margin:14mm}
      }
      `}</style>
    </div>
  );
}

function DayPicker({ day, days, onPick }: { day: string; days: { value: string; label: string }[]; onPick: (d: string) => void }) {
  return (
    <select className="daypick" value={day} onChange={(e) => onPick(e.target.value)} aria-label="Packing day">
      {days.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
    </select>
  );
}
