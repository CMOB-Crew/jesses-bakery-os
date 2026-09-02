"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PackRun, PackState } from "@/lib/queries";
import { setPackingState } from "@/app/run-state-actions";

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
// `lines` is the per-PRODUCT tick, keyed by product name. A store is not
// packed because someone hit one big button -- it is packed because every line
// on its slip was ticked off. That is the whole point of the rebuild: the
// printed slip has always been a line-by-line checklist and the screen was a
// single tick per store, so the screen could say "packed" while a product was
// still sitting on the bench.
type UIStore = { store_id: string; name: string; retailer: string; items: [string, number][]; units: number; status: SStatus; comment: string; lines: Record<string, boolean> };
type UIRun = { run_id: string; name: string; stores: UIStore[]; units: number };

const CHIPS = ["Short on the order", "Item damaged", "Substituted product", "Out of stock — nothing to pack"];
const CHIP_LABEL: Record<string, string> = { "Short on the order": "Short", "Item damaged": "Damaged", "Substituted product": "Substituted", "Out of stock — nothing to pack": "Out of stock" };

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function toUI(runs: PackRun[], saved: PackState = {}): UIRun[] {
  return runs.map((r) => ({
    run_id: r.run_id,
    name: r.name,
    units: r.units,
    stores: r.stores.map((s) => ({
      store_id: s.store_id,
      name: s.name,
      retailer: s.retailer,
      items: s.items.map((i) => [i.name, i.qty] as [string, number]),
      // Ticked lines come back as a name array. A store saved before this
      // existed simply has none, and a store already marked packed gets every
      // line ticked so an old sheet opens complete rather than untouched.
      lines: (() => {
        const ticked = saved[s.store_id]?.i;
        if (Array.isArray(ticked) && ticked.length) {
          const m: Record<string, boolean> = {};
          for (const n of ticked) m[n] = true;
          return m;
        }
        if (saved[s.store_id]?.s === "packed") {
          const m: Record<string, boolean> = {};
          for (const i of s.items) m[i.name] = true;
          return m;
        }
        return {};
      })(),
      units: s.units,
      // Seeded from what was saved for this day, so a reload, or an iPad
      // that locked itself, picks up where the packer left off.
      status: (saved[s.store_id]?.s ?? "pending") as SStatus,
      comment: saved[s.store_id]?.c ?? "",
    })),
  }));
}

export default function PackingApp({
  runs: runsIn,
  day,
  dayLabel,
  days,
  who,
  initial = {},
}: {
  runs: PackRun[];
  day: string;
  dayLabel: string;
  days: { value: string; label: string }[];
  who: string;
  initial?: PackState;
}) {
  const router = useRouter();
  // Keyed by day so switching days starts a clean sheet rather than carrying
  // yesterday's ticks onto today's stores.
  const [runs, setRuns] = useState<UIRun[]>(() => toUI(runsIn, initial));
  // Save the sheet whenever it changes.
  //
  // The ref skips the FIRST pass. Without it the initial render would write the
  // starting state straight back over what was just loaded -- the same
  // read-then-clobber that pinned permanent overrides on the delivery sheet
  // just by opening it (d889cdf).
  //
  // day is not in the deps because the page sets key={day} on this component,
  // so a day change remounts rather than re-running the effect.
  const firstPass = useRef(true);
  useEffect(() => {
    if (firstPass.current) { firstPass.current = false; return; }
    const next: PackState = {};
    for (const r of runs) {
      for (const s of r.stores) {
        const ticked = s.items.map((i) => i[0]).filter((n) => s.lines[n]);
        // Half-finished stores are saved too. A packer who ticks nine of
        // fourteen lines and walks away has done real work, and losing it on a
        // locked screen is exactly what this sheet promises not to do.
        if (s.status === "packed") next[s.store_id] = { s: "packed", i: ticked };
        else if (s.status === "flagged") next[s.store_id] = { s: "flagged", c: s.comment, i: ticked };
        else if (ticked.length) next[s.store_id] = { s: "pending", i: ticked };
      }
    }
    void (async () => {
      const res = await setPackingState(day, next);
      if (!res.ok) setToast(`Could not save: ${res.error}`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);
  // Which stores are on a standing order rather than a plan. Read straight off
  // the server rows by id, so neither UIStore nor toUI has to change.
  const standingIds = useMemo(
    () => new Set(runsIn.flatMap((r) => r.stores.filter((s) => s.standing).map((s) => s.store_id))),
    [runsIn],
  );
  const standingCount = standingIds.size;
  const [cur, setCur] = useState(0);
  // One store open at a time. A packer works a store, finishes it, moves on --
  // twenty-seven stores of expanded lines at once is not a checklist, it is a
  // wall.
  const [open, setOpen] = useState<number | null>(0);
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
  const lineCount = (s: UIStore) => s.items.filter((i) => s.lines[i[0]]).length;
  const allLines = (s: UIStore) => s.items.length > 0 && lineCount(s) === s.items.length;

  function toggleLine(si: number, name: string) {
    mutate(si, (s) => {
      const lines = { ...s.lines, [name]: !s.lines[name] };
      // Unticking a line on a completed store reopens it. The count on the run
      // list has to be able to go DOWN, or "12 of 14 packed" stops being true
      // the moment someone corrects a mistake.
      const stillAll = s.items.length > 0 && s.items.every((i) => lines[i[0]]);
      const status: SStatus = s.status === "packed" && !stillAll ? "pending" : s.status;
      return { ...s, lines, status };
    });
  }

  function completeStore(si: number) {
    mutate(si, (s) => ({ ...s, status: "packed", comment: "" }));
    setFlagOpen((f) => ({ ...f, [key(si)]: false }));
    // Straight on to the next store that still needs doing, so finishing one
    // hands you the next instead of sending you back to a list to find it.
    const stores = runs[cur].stores;
    const nextIdx = stores.findIndex((s, i) => i !== si && s.status === "pending");
    setOpen(nextIdx === -1 ? null : nextIdx);
  }

  function togglePack(si: number) {
    mutate(si, (s) => {
      const to: SStatus = s.status === "packed" ? "pending" : "packed";
      const lines: Record<string, boolean> = {};
      // The header tick is an all-or-nothing shortcut, so it has to move the
      // lines with it. Leaving them behind would show "packed" above a list of
      // empty boxes.
      if (to === "packed") for (const i of s.items) lines[i[0]] = true;
      return { ...s, status: to, comment: "", lines };
    });
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
        Ticks and flags <b>save as you go</b> and are stamped with who made them, so a reload or a locked screen picks up where you left off. <b>Finalise</b> still does not send anything to the drivers. <b>Export PDF</b> prints the real slip.
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
                const itemsShown = open === si;
                const done = lineCount(s);
                const ready = allLines(s);
                const flagShown = !!flagOpen[key(si)];
                const reason = draft[key(si)] || "";
                return (
                  <div key={s.store_id} className={`srow ${s.status} ${itemsShown ? "open" : ""}`}>
                    <div
                      className="srhead"
                      role="button"
                      tabIndex={0}
                      aria-expanded={itemsShown}
                      onClick={() => setOpen(itemsShown ? null : si)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(itemsShown ? null : si); } }}
                    >
                      {/* stopPropagation: the tick is an all-or-nothing shortcut and
                          must not also open the store underneath it. */}
                      <div className="check" onClick={(e) => { e.stopPropagation(); togglePack(si); }}>✓</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="nm">{s.name}</div>
                        <div className="it">{s.units} items · {done > 0 && s.status !== "packed" ? <b>{done}/{s.items.length} lines</b> : `${s.items.length} products`} {standingIds.has(s.store_id) && <span className="tag amber" title="No sales feed to size this store — this is its current standing order, not a forecast.">standing order</span>} {s.status === "flagged" && <span className="tag amber">⚑ flagged</span>}</div>
                        {s.status === "flagged" && <div className="cmt">⚑ {s.comment}</div>}
                      </div>
                      <button className="exp" onClick={() => setOpen(itemsShown ? null : si)}>{itemsShown ? "close" : s.status === "packed" ? "review" : "pack this store"}</button>
                    </div>
                    {itemsShown && (
                      <div className="lines">
                        {s.items.map((i) => {
                          const on = !!s.lines[i[0]];
                          return (
                            <button
                              type="button"
                              key={i[0]}
                              className={`lrow ${on ? "on" : ""}`}
                              aria-pressed={on}
                              onClick={() => toggleLine(si, i[0])}
                            >
                              <span className="lbox">{on ? "✓" : ""}</span>
                              <span className="lname">{i[0]}</span>
                              <span className="lqty">{i[1]}</span>
                            </button>
                          );
                        })}
                        <div className="lfoot">
                          <span className="lprog">{ready ? `All ${s.items.length} lines ticked.` : `${done} of ${s.items.length} lines ticked`}</span>
                          <button className="btn done sm" disabled={!ready || s.status === "packed"} onClick={() => completeStore(si)}>
                            {s.status === "packed" ? "Store complete" : `Complete ${s.name.split(" ").slice(-1)[0] || "store"}`}
                          </button>
                        </div>
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
                      <div className="flagrow">
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
      .packwrap .lines{margin-top:12px;border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:6px}
      .packwrap .lrow{display:flex;align-items:center;gap:13px;width:100%;text-align:left;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:11px 14px;cursor:pointer;font:inherit;color:inherit;transition:.12s}
      .packwrap .lrow:hover{border-color:var(--crust)}
      .packwrap .lrow:focus-visible{outline:none;border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.2)}
      .packwrap .lrow.on{background:#f4f8f2;border-color:#cfe2c6}
      .packwrap .lbox{width:30px;height:30px;border-radius:8px;border:2px solid var(--line);background:var(--card);flex:none;display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1;color:transparent}
      .packwrap .lrow.on .lbox{background:var(--green);border-color:var(--green);color:#fff}
      .packwrap .lname{flex:1;min-width:0;font-size:14.5px;font-weight:600;overflow-wrap:anywhere}
      .packwrap .lrow.on .lname{color:var(--ink2)}
      .packwrap .lqty{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;flex:none;min-width:38px;text-align:right}
      .packwrap .lfoot{display:flex;align-items:center;gap:12px;padding:4px 2px 2px;margin-top:2px}
      .packwrap .lprog{font-size:12.5px;color:var(--muted);font-weight:600}
      .packwrap .btn.done{margin-left:auto;background:var(--green);color:#fff;border:0}
      .packwrap .btn.done:disabled{background:#dfe3da;color:#8d9487;cursor:default}
      @media (prefers-reduced-motion:reduce){.packwrap .lrow{transition:none}}

      /* ---- ON A REAL TABLET ----------------------------------------
         Everything above draws a PICTURE of an iPad: a black bezel at a fixed
         1120x760 with the explanation copy above it, which is right for
         showing the thing on a laptop and absurd on the device itself -- an
         iPad drawn inside an iPad, at a height that is not the screen's.

         Two conditions on purpose. pointer:coarse catches every touch device.
         max-width:900px catches anything narrow, which means a laptop browser
         squeezed down shows exactly what a packer sees -- so this is checkable
         without borrowing the bakery's iPad, and a device that misreports its
         pointer still gets the right layout.

         Simona's laptop at full width is well past 900px, so the demo view she
         is shown is untouched. Add to Home Screen opens it with no Safari
         chrome at all. */
      @media (pointer: coarse), (max-width: 900px){
        .packwrap{padding:0;align-items:stretch}
        .packwrap .livenote, .packwrap .cap{display:none}
        .packwrap .pad{width:100%;max-width:none;height:100dvh;border-radius:0;padding:0;box-shadow:none;background:var(--paper)}
        .packwrap .app{border-radius:0;height:100dvh}
        /* Runs become a strip across the top: a packer picks a run once and
           then works down the stores, so it does not deserve a third of the
           screen for the rest of the shift. */
        .packwrap .body{flex-direction:column}
        .packwrap .runs{width:auto;border-right:0;border-bottom:1px solid var(--line);display:flex;gap:10px;overflow-x:auto;padding:12px 14px;flex:none}
        .packwrap .runs .h{display:none}
        .packwrap .run{margin-bottom:0;min-width:190px;flex:none}
        .packwrap .list{padding:10px 14px}
        .packwrap .mh{padding:14px 16px 4px}
        /* Bigger targets. This is used with flour on your hands. */
        .packwrap .lrow{padding:15px 16px}
        .packwrap .lbox{width:38px;height:38px;font-size:21px}
        .packwrap .lname{font-size:16px}
        .packwrap .lqty{font-size:19px;min-width:46px}
        .packwrap .check{width:46px;height:46px}
        .packwrap .foot{padding:12px 16px;padding-bottom:calc(12px + env(safe-area-inset-bottom))}
        .packwrap .pexport{display:none !important}
        /* The PAGE's own "Packing" heading and strapline sit above this
           component. On a laptop that is the frame around a demo. On a phone
           it is furniture you scroll past to reach the work, and with the app
           pinned at 100dvh underneath it the checklist could never fit on one
           screen -- which is exactly what the phone screenshots showed.
           The app carries its own header, so the page's is redundant here. */
        .head{display:none}
        /* Let the document scroll as one thing rather than an app-in-a-box
           with its own inner scroller. A phone has one scroll gesture; giving
           it two nested ones is how you lose your place mid-run. */
        .packwrap .pad{height:auto;min-height:100dvh}
        .packwrap .app{height:auto;min-height:100dvh}
        .packwrap .body{min-height:0}
        .packwrap .main{min-height:0}
        .packwrap .list{overflow:visible;flex:none}
        /* Clear of the notch and the status bar. */
        /* NOT unconditionally. Safari already positions the page below the
           status bar, so adding the inset here as well pushed the header a
           long way down the screen -- that was most of the dead space at the
           top. It is only needed once the page runs as a home-screen app with
           no browser chrome above it. */
        @media (display-mode: standalone){
          .packwrap .top{padding-top:calc(14px + env(safe-area-inset-top))}
        }
      }

      /* ---- ON A PHONE ----------------------------------------------
         The block above is sized for an iPad. A phone is 390px wide, where
         that header overflows, a 190px run card shows one and a half, and the
         Complete button sits beside its own label instead of under it.

         Drivers and packers both said they would use their phones, so this is
         a real surface, not a courtesy.

         Everything here is layout, not function -- same checklist, same ticks,
         same rules. Tap targets stay at or above 44px throughout, which is the
         floor for a thumb. */
      @media (max-width: 560px){
        /* The wordmark is decoration; on a phone it costs the day picker its
           room. The mark stays so the header still reads as ours. */
        .packwrap .top{padding:10px 12px;gap:8px}
        .packwrap .top .logo{font-size:0}
        .packwrap .top .logo .mk{font-size:19px}
        .packwrap .top h1{font-size:17px;margin-left:0}
        .packwrap .daypick{padding:9px 8px;font-size:12.5px;min-width:0;flex:1}
        /* Avatar only. The name is already on every action in the audit trail;
           it does not also need a third of the header. */
        .packwrap .top .who{max-width:none;padding:0;background:none;border:0;font-size:0;gap:0}
        .packwrap .top .who .av{width:34px;height:34px;font-size:14px}

        .packwrap .runs{padding:10px 12px;gap:8px}
        .packwrap .run{min-width:150px;padding:10px 12px}
        .packwrap .run .rn{font-size:14px}
        .packwrap .run .rd{font-size:11px;margin:1px 0 6px}
        .packwrap .run .rc{font-size:11px}

        .packwrap .mh{padding:12px 12px 2px;flex-wrap:wrap;gap:2px 10px}
        .packwrap .mh h2{font-size:20px}
        .packwrap .mh .ms{font-size:12px}
        .packwrap .list{padding:8px 12px}

        .packwrap .srow{padding:12px}
        .packwrap .srhead{gap:11px}
        .packwrap .check{width:44px;height:44px;font-size:23px}
        .packwrap .srhead .nm{font-size:15px;overflow-wrap:anywhere}
        .packwrap .srhead .it{font-size:12px}
        /* The open/close control drops under the name rather than fighting it
           for width on a long store name like WOOLWORTHS BURWOOD WESTFIELD. */
        .packwrap .srhead{flex-wrap:wrap}
        .packwrap .srhead .exp{margin-left:54px;padding:6px 0;font-size:13.5px}

        .packwrap .lrow{padding:13px 12px;gap:11px}
        .packwrap .lbox{width:36px;height:36px}
        .packwrap .lname{font-size:15px}
        .packwrap .lqty{font-size:18px;min-width:38px}

        /* Stacked, and the button goes full width. A thumb reaching across a
           phone should not have to find a small target in the corner. */
        .packwrap .lfoot{flex-direction:column;align-items:stretch;gap:8px}
        .packwrap .lfoot .lprog{text-align:center}
        .packwrap .btn.done{margin-left:0;width:100%;padding:13px;font-size:15px}
        .packwrap .foot{flex-direction:column;align-items:stretch;gap:9px}
        .packwrap .foot .st{text-align:center;font-size:12.5px}
        .packwrap .final{width:100%;padding:13px;font-size:15px}

        /* The flag panel is a form, and forms are where phones go wrong. */
        .packwrap .flagpanel input{width:100%}
        .packwrap .flagpanel .chips{gap:6px}

        /* The header row was wrapping into three: box alone, then the name,
           then "close" stranded on the right by the margin-left:auto it
           inherits. Pin the tick and the name on one line and give the
           open/close control a full-width row of its own underneath. */
        .packwrap .srhead > div:nth-child(2){flex:1 1 auto}
        .packwrap .srhead .exp{flex:0 0 100%;margin-left:0;text-align:left;padding:8px 0 2px}
        /* The retailer tag was pushing "14 items - 4 products" onto two lines.
           Let the whole meta line wrap as one block instead. */
        .packwrap .srhead .it{flex-wrap:wrap;gap:5px}

        /* Product names were breaking across three lines. Reclaim the width:
           tighter gap, narrower quantity column, and hyphenate long names
           rather than stacking every word. */
        .packwrap .lrow{gap:9px;padding:12px 10px}
        .packwrap .lname{font-size:14.5px;line-height:1.3;hyphens:auto}
        .packwrap .lqty{min-width:30px;font-size:17px}
        .packwrap .lbox{width:34px;height:34px}

        /* Two run cards should fit, not one and a sliver. */
        .packwrap .run{min-width:132px;padding:9px 11px}
        .packwrap .run .rn{font-size:13px}
      }

      /* A phone held sideways has almost no height. Give the list the screen
         back by collapsing the run strip to a single scrollable line. */
      @media (pointer: coarse) and (max-height: 460px){
        .packwrap .runs{padding:7px 12px}
        .packwrap .run .track, .packwrap .run .rd{display:none}
        .packwrap .run{padding:8px 12px}
        .packwrap .mh{padding-top:8px}
      }
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
      /* ---- THE PHONE LAYOUT ----------------------------------------
         Written for a phone, not shrunk from a laptop.

         What was wrong: a narrow column of small text floating in the middle
         of a 390px screen, inset from both edges by the app shell's 30px page
         margin, with 12px labels and 34px targets. It read as a website that
         had been squeezed. This is a thing someone uses at 5am with flour on
         their hands.

         So: full bleed to the edges, and everything sized up. Store names
         18px, product names 17px, quantities 24px, tick targets 44-46px.
         Nothing here is decorative -- the name, the count and the number are
         the whole job.

         Every selector carries an extra element (div.check, button.exp,
         .srow .srhead) because the base rules sit LATER in this stylesheet and
         win on source order otherwise. */
      @media (max-width: 560px){
        /* globals.css wraps every page in .main{padding:22px 30px 70px}. That
           page margin is why the cards sat in a narrow column with air either
           side. Packing is full bleed here. */
        .main{padding:0}

        /* The run name and counts are repeated verbatim on the run card
           directly above, which is already outlined as the selected one. */
        .packwrap .mh{display:none}

        .packwrap .top{padding:12px 14px;gap:10px}
        /* Two runs visible at once, always, with the third peeking so it is
           obvious the strip scrolls. A fixed 162px card meant one and a bit on
           a narrow phone and left the strip short of the right edge; halves of
           the actual width cannot get that wrong.
             available = 100% - 24px padding
             two cards + one 8px gap  ->  card = 50% - 16px
           A couple of px come off that to leave the peek. */
        .packwrap .runs{width:100%;padding:10px 12px;gap:8px;
          scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch}
        .packwrap .run{min-width:0;width:auto;flex:0 0 calc(50% - 20px);
          padding:11px 13px;scroll-snap-align:start}
        .packwrap .run .rn{font-size:14px}
        .packwrap .run .rd{font-size:11.5px}
        .packwrap .list{padding:12px 10px calc(40px + env(safe-area-inset-bottom))}

        /* ---- a store, closed: one row, big enough to hit without looking */
        .packwrap .srow{padding:0;margin-bottom:10px;border-radius:14px;overflow:hidden}
        .packwrap .srow .srhead{display:grid;grid-template-columns:auto 1fr auto;
          align-items:center;gap:14px;padding:16px 14px;cursor:pointer;flex-wrap:nowrap}
        .packwrap .srow.open .srhead{border-bottom:1px solid var(--line)}
        .packwrap .srow .srhead > div.check{width:46px;height:46px;font-size:25px;margin:0;border-radius:12px}
        .packwrap .srow .srhead > div:nth-child(2){flex:none;min-width:0}
        .packwrap .srow .srhead .nm{font-size:18px;line-height:1.2;font-weight:600}
        .packwrap .srow .srhead .it{font-size:13.5px;margin-top:5px;display:block;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .packwrap .srow .srhead .it .tag{display:inline-block;vertical-align:middle;
          margin-left:6px;font-size:11px;padding:3px 8px}

        /* The row is the target, so the text link is redundant. */
        .packwrap .srow .srhead button.exp{display:none}
        .packwrap .srow .srhead::after{content:"";width:11px;height:11px;flex:none;
          border-right:2.5px solid var(--crust);border-bottom:2.5px solid var(--crust);
          transform:rotate(-45deg);margin-right:6px;transition:transform .15s}
        .packwrap .srow.open .srhead::after{transform:rotate(45deg)}

        /* ---- a store, open: the checklist gets the screen */
        .packwrap .lines{margin-top:0;border-top:0;padding:12px 12px 14px;gap:9px}
        .packwrap .lrow{padding:16px 14px;gap:14px;border-radius:12px}
        .packwrap .lbox{width:42px;height:42px;font-size:24px;border-radius:10px}
        .packwrap .lname{font-size:17px;line-height:1.25;font-weight:600}
        .packwrap .lqty{font-size:24px;min-width:42px}

        .packwrap .lfoot{flex-direction:column;align-items:stretch;gap:10px;padding:4px 2px 0}
        .packwrap .lfoot .lprog{text-align:center;font-size:14px}
        .packwrap .btn.done{margin-left:0;width:100%;padding:16px;font-size:16px;border-radius:12px}

        /* Flagging belongs to the store in front of you, not to a link under
           all twenty-seven of them. */
        .packwrap .srow:not(.open) .flagrow{display:none}
        .packwrap .srow .flagrow{padding:0 14px 14px}
        .packwrap .srow .flagrow button.exp{margin-left:0;font-size:15px}

        .packwrap .flagpanel{padding:0 14px 14px}
        .packwrap .flagpanel input{width:100%;font-size:16px;padding:12px}

        .packwrap .foot{flex-direction:column;align-items:stretch;gap:10px;
          padding:14px 14px calc(14px + env(safe-area-inset-bottom))}
        .packwrap .foot .st{text-align:center;font-size:13.5px}
        .packwrap .final{width:100%;padding:16px;font-size:16px;border-radius:12px}

        /* A packed store reads as done while scrolling past. */
        .packwrap .srow.packed .srhead .nm{color:var(--ink2)}
        .packwrap .srow.packed .srhead::after{border-color:var(--green)}
      }

      /* Only in standalone. Safari already clears the status bar, and adding
         the inset there as well was most of the dead space at the top. */
      @media (display-mode: standalone){
        .packwrap .top{padding-top:calc(14px + env(safe-area-inset-top))}
      }

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
