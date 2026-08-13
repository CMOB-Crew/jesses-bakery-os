"use client";

import { useMemo, useRef, useState } from "react";

// Packing app — iPad prototype. Big tick-off targets, a mandatory comment on any
// discrepancy, every action stamped to the packer — the accountability the
// current PDF slips don't have. Ties to per-production-area logins later.
// Prototype only; finalise + write-back to drivers/back-end is the next phase.

type SStatus = "pending" | "packed" | "flagged";
type Store = { name: string; items: [string, number][]; status: SStatus; comment: string };
type Run = { name: string; days: string; stores: Store[] };

const mk = (name: string, items: [string, number][]): Store => ({ name, items, status: "pending", comment: "" });

const INITIAL: Run[] = [
  { name: "Eastern Suburbs", days: "Mon · Wed · Fri · Sat", stores: [
    mk("Coles Bondi Junction", [["White Sourdough", 6], ["Plain Bagel", 8], ["Mini Challah", 4], ["Pita", 5]]),
    mk("Woolworths Bondi Beach", [["White Sourdough", 5], ["Sesame Bagel", 6], ["Pita", 4]]),
    mk("Coles Randwick", [["Spelt Sourdough", 7], ["Plain Bagel", 9], ["Mini Challah", 3]]),
    mk("Harris Farm Bondi", [["White Sourdough", 8], ["Rye Sourdough", 4], ["Poppy Bagel", 6]]),
    mk("Coles Coogee", [["White Sourdough", 6], ["Plain Bagel", 7]]),
    mk("Woolworths Maroubra", [["Spelt Sourdough", 9], ["Sesame Bagel", 8]]),
  ] },
  { name: "Inner West", days: "Mon · Wed · Fri", stores: [
    mk("Coles Ashfield", [["White Sourdough", 7], ["Plain Bagel", 9]]),
    mk("Coles Marrickville", [["Spelt Sourdough", 6], ["Sesame Bagel", 7], ["Pita", 5]]),
    mk("Woolworths Balmain", [["White Sourdough", 5], ["Mini Challah", 4]]),
  ] },
  { name: "City", days: "Daily", stores: [
    mk("Coles World Square", [["White Sourdough", 9], ["Plain Bagel", 10], ["Pita", 6]]),
    mk("Metro Surry Hills", [["Spelt Sourdough", 7], ["Poppy Bagel", 6]]),
  ] },
];

const CHIPS = ["Short 2 sourdough", "Item damaged", "Substituted product", "Out of stock — nothing to pack"];
const CHIP_LABEL: Record<string, string> = { "Short 2 sourdough": "Short 2", "Item damaged": "Damaged", "Substituted product": "Substituted", "Out of stock — nothing to pack": "Out of stock" };

export default function PackingApp() {
  const [runs, setRuns] = useState<Run[]>(INITIAL);
  const [cur, setCur] = useState(0);
  const [expItems, setExpItems] = useState<Record<string, boolean>>({});
  const [flagOpen, setFlagOpen] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = runs[cur];
  const key = (si: number) => `${cur}:${si}`;
  const packed = (r: Run) => r.stores.filter((s) => s.status !== "pending").length;
  const curPacked = packed(run);
  const allDone = curPacked === run.stores.length;

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  function mutate(si: number, fn: (s: Store) => Store) {
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

  const runsMeta = useMemo(() => runs.map((r) => ({ p: packed(r), n: r.stores.length })), [runs]);

  return (
    <div className="packwrap">
      <div className="cap">Packing app · iPad prototype. Big tick-off targets, a mandatory comment on any discrepancy, and every action stamped to the packer — the accountability the current PDF slips don&apos;t have.</div>
      <div className="pad"><div className="app">
        <div className="top">
          <span className="logo"><span className="mk">✦</span> Jesse&apos;s Bakery</span><h1>Packing</h1>
          <span className="date">Monday 9 Aug · 6:52am</span>
          <span className="who"><span className="av">P</span>Priya · Packing</span>
        </div>
        <div className="body">
          <div className="runs">
            <div className="h">Today&apos;s runs</div>
            {runs.map((r, i) => {
              const { p, n } = runsMeta[i];
              const done = p === n;
              return (
                <div key={r.name} className={`run ${i === cur ? "on" : ""}`} onClick={() => setCur(i)}>
                  <div className="rn">{r.name}<span className="cdot" style={{ background: done ? "var(--green)" : "var(--crust)" }} /></div>
                  <div className="rd">{r.days} · {r.stores.length} stores</div>
                  <div className="track"><i style={{ width: `${(100 * p) / n}%` }} /></div>
                  <div className="rc">{p} of {n} packed</div>
                </div>
              );
            })}
          </div>

          <div className="main">
            <div className="mh"><h2>{run.name}</h2><span className="ms">{run.days} · {run.stores.length} stores</span></div>
            <div className="list">
              {run.stores.map((s, si) => {
                const itemsShown = !!expItems[key(si)];
                const flagShown = !!flagOpen[key(si)];
                const total = s.items.reduce((a, b) => a + b[1], 0);
                const reason = draft[key(si)] || "";
                return (
                  <div key={s.name} className={`srow ${s.status}`}>
                    <div className="srhead">
                      <div className="check" onClick={() => togglePack(si)}>✓</div>
                      <div style={{ minWidth: 0 }}>
                        <div className="nm">{s.name}</div>
                        <div className="it">{total} items · {s.items.length} products {s.status === "flagged" && <span className="tag amber">⚑ flagged</span>}</div>
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
              <span className="st">{allDone ? `All ${run.stores.length} stores resolved — ready to finalise.` : `${run.stores.length - curPacked} store(s) still to pack or flag.`}</span>
              <button className="final" disabled={!allDone} onClick={() => showToast(`✓ ${run.name} run finalised by Priya at 7:14am — flows to the drivers and the back-end (next phase).`)}>
                {allDone ? `Finalise ${run.name} run` : "Finalise run"}
              </button>
            </div>
          </div>
        </div>
      </div></div>

      {toast && <div className="packtoast">{toast}</div>}

      <style>{`
      .packwrap{display:flex;flex-direction:column;align-items:center;padding:6px 0 30px}
      .packwrap .cap{font-size:12.5px;color:var(--muted);margin-bottom:12px;text-align:center;max-width:760px;line-height:1.5}
      .packwrap .pad{width:1120px;max-width:100%;height:760px;background:#151009;border-radius:30px;padding:14px;box-shadow:0 30px 70px -22px rgba(40,25,10,.5)}
      .packwrap .app{background:var(--paper);border-radius:18px;height:100%;overflow:hidden;display:flex;flex-direction:column}
      .packwrap .top{padding:16px 22px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line)}
      .packwrap .top .logo{font-family:var(--serif);font-weight:600;font-size:18px}
      .packwrap .top .logo .mk{color:var(--crust)}
      .packwrap .top h1{font-family:var(--serif);font-size:20px;font-weight:600;margin-left:6px}
      .packwrap .top .date{font-size:13px;color:var(--muted)}
      .packwrap .top .who{margin-left:auto;display:flex;align-items:center;gap:9px;background:var(--surface);border:1px solid var(--line);padding:6px 12px 6px 6px;border-radius:999px;font-size:13px;font-weight:600}
      .packwrap .top .who .av{width:28px;height:28px;border-radius:50%;background:var(--espresso);color:#f0e6d2;display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-size:13px}
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
      `}</style>
    </div>
  );
}
