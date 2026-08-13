"use client";

import { useMemo, useRef, useState } from "react";
import StoreBars from "@/components/StoreBars";
import type { StoreWeek, StoreReco, DailyBar } from "@/lib/queries";

const nf = (n: number) => n.toLocaleString("en-AU");

type Adj = { qty: number; mode: "perm" | "temp"; from?: string; to?: string };
type Row = { name: string; sold: number; now: number; rec: number };

const SCORE = {
  green: { dot: "🟢", label: "High performer", cls: "g" },
  amber: { dot: "🟡", label: "Opportunity", cls: "a" },
  red: { dot: "🔴", label: "Underperformer", cls: "r" },
} as const;

// Simona's "most important screen": the store profile as the single source of
// truth. Range products in/out, set this store's service level, and make
// temporary (date-ranged, auto-resetting) or permanent adjustments — with the
// shelf cap enforced. Editing is live here; persisting to the backend profile
// is the next build phase (flagged honestly in the UI).
export default function StoreProfile({
  store,
  recos,
  daily,
}: {
  store: StoreWeek;
  recos: StoreReco[];
  daily: DailyBar[];
}) {
  // Coerce every DB number up front (waste_pct/shelf_max arrive as strings).
  const wastePct = store.waste_pct == null ? null : Number(store.waste_pct);
  const soldWk = Number(store.total_sold) || 0;
  const sentWk = Number(store.total_sent) || 0;
  const soldPrev = Number(store.total_sold_prev) || 0;
  const stockouts = Number(store.stockout_days) || 0;
  const cap = store.shelf_max == null ? null : Number(store.shelf_max);
  const sellThrough = sentWk > 0 ? Math.round((1000 * soldWk) / sentWk) / 10 : null;
  const growth = soldPrev > 0 ? Math.round((1000 * (soldWk - soldPrev)) / soldPrev) / 10 : null;
  const score = SCORE[store.status];

  const rows: Row[] = useMemo(
    () => recos.map((r) => ({ name: r.product_name, sold: Number(r.sold) || 0, now: Number(r.sent) || 0, rec: Number(r.recommended) || 0 })),
    [recos],
  );

  const [dial, setDial] = useState<"lean" | "balanced" | "service">("balanced");
  const [ranged, setRanged] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((r) => [r.name, true])));
  const [adj, setAdj] = useState<Record<string, Adj>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const isRanged = (name: string) => ranged[name] !== false;
  const eff = (r: Row) => adj[r.name]?.qty ?? r.rec; // effective "final delivery"
  const rangedRows = rows.filter((r) => isRanged(r.name));
  const rangedCount = rangedRows.length;
  const capTotal = rangedRows.reduce((a, r) => a + eff(r), 0);
  const overCap = cap != null && capTotal > cap;

  function toggleRanged(name: string) {
    setRanged((s) => ({ ...s, [name]: !isRanged(name) }));
  }

  const metrics: { k: string; v: string; cls?: string; soft?: boolean }[] = [
    { k: "Weekly sales", v: "$ —", soft: true },
    { k: "Sell-through", v: sellThrough == null ? "—" : `${sellThrough}%`, cls: sellThrough != null && sellThrough >= 85 ? "g" : undefined },
    { k: "Units sold · wk", v: nf(soldWk) },
    { k: "Waste", v: wastePct == null ? "—" : `${wastePct}%`, cls: wastePct != null && wastePct <= 20 ? "g" : wastePct != null && wastePct > 25 ? "r" : "a" },
    { k: "Est. waste $", v: "$ —", soft: true },
    { k: "Stockout days", v: stockouts ? `${stockouts}` : "0", cls: stockouts ? "a" : undefined },
    { k: "Sales growth", v: growth == null ? "—" : `${growth >= 0 ? "▲" : "▼"} ${Math.abs(growth)}%`, cls: growth == null ? undefined : growth >= 0 ? "g" : "r" },
    { k: "Forecast accuracy", v: "—", soft: true },
  ];

  return (
    <section className="sprof">
      <div className="hero">
        <div className="hero-l">
          <div className="nm">{store.name}</div>
          <div className="sub">
            {store.size_category ? <span className="chip">{store.size_category}</span> : null}
            {cap != null ? <span className="chip">shelf cap {nf(cap)}</span> : <span className="chip soft">cap not set</span>}
            {store.region ? <span className="reg">{store.region}</span> : null}
            <span className="rtl">{store.retailer}</span>
          </div>
        </div>
        <div className={`scorebadge ${score.cls}`}>
          <span className="sd">{score.dot}</span>
          <span className="st">{score.label}<small>vs same-size stores · provisional</small></span>
        </div>
      </div>

      <div className="mgrid">
        {metrics.map((m) => (
          <div className="m" key={m.k}>
            <div className={`mv ${m.cls ?? ""} ${m.soft ? "soft" : ""}`}>{m.v}</div>
            <div className="ml">{m.k}</div>
          </div>
        ))}
      </div>
      <div className="softnote">$ sales, waste value, profit and forecast accuracy light up once the cost feed is wired in — the numbers already sit in the retailer data.</div>

      {daily.length > 0 && (
        <div className="chartcard">
          <div className="cc-h">Daily units this week <span>sold vs delivered · no running totals</span></div>
          <StoreBars data={daily} />
          <div className="cc-leg">
            <span><i style={{ background: "#2a2019" }} />Sold</span>
            <span><i style={{ background: "#e7ddca" }} />Delivered</span>
          </div>
        </div>
      )}

      <div className="dialrow">
        <div className="dial-l">
          <div className="dl-t">Service level · this store</div>
          <div className="dl-s">Sets the waste-vs-stockout trade-off for every product here — not just loaves. The engine re-sizes each line to match.</div>
        </div>
        <div className="seg">
          {(["lean", "balanced", "service"] as const).map((s) => (
            <button key={s} type="button" className={dial === s ? "on" : ""} onClick={() => { setDial(s); showToast(`Service level set to ${s} for ${store.name} — the engine retunes every line to match (wired next phase)`); }}>
              {s[0].toUpperCase() + s.slice(1)}
              {s === "balanced" && <small>default</small>}
            </button>
          ))}
        </div>
      </div>

      <div className="ph">
        <div className="ph-t">Products &amp; ranging <span className="cnt">{rangedCount}/{rows.length} ranged</span></div>
        <div className="ph-cap">
          {cap == null ? (
            <span className="soft">shelf cap not set for this store</span>
          ) : (
            <span className={overCap ? "over" : "ok"}>
              {overCap ? "⚠ " : ""}{nf(capTotal)} / {nf(cap)} units{overCap ? " — over shelf cap" : ""}
            </span>
          )}
        </div>
      </div>

      {overCap && (
        <div className="capwarn">
          <b>This exceeds the store&apos;s shelf cap of {nf(cap!)}.</b> A store can&apos;t hold more than it fits — untick a product, trim an adjustment, or keep it as a one-off override. Nothing goes out over cap without your OK.
        </div>
      )}

      {rows.length > 0 ? (
        <div className="sheet">
          <div className="colhead"><div className="grid">
            <div className="c">Ranged</div>
            <div>Product</div>
            <div className="r">Sold</div>
            <div className="r soft">Now</div>
            <div className="r">Final delivery</div>
            <div className="r">Adjust</div>
          </div></div>
          {rows.map((r) => {
            const on = isRanged(r.name);
            const a = adj[r.name];
            const v = eff(r);
            const isEdit = editing === r.name;
            return (
              <div className={`row ${on ? "" : "off"}`} key={r.name}>
                <div className="grid">
                  <div className="c">
                    <button type="button" className={`sw ${on ? "on" : ""}`} aria-label={`toggle ranging ${r.name}`} onClick={() => toggleRanged(r.name)}>
                      <span className="knob" />
                    </button>
                  </div>
                  <div className="pn">
                    {r.name}
                    {!on && <span className="notr">not ranged · driver diverts today</span>}
                    {a && on && <span className={`apill ${a.mode}`}>{a.mode === "perm" ? "permanent" : `until ${a.to || "—"}`} · {v}</span>}
                  </div>
                  <div className="r">{on ? nf(r.sold) : "—"}</div>
                  <div className="r soft">{on ? nf(r.now) : "—"}</div>
                  <div className="r fd">{on ? nf(v) : "—"}</div>
                  <div className="r">
                    {on ? (
                      <button type="button" className="adjbtn" onClick={() => setEditing(isEdit ? null : r.name)}>{a ? "Edit" : "Adjust"}</button>
                    ) : "—"}
                  </div>
                </div>
                {isEdit && on && (
                  <AdjustEditor
                    row={r}
                    current={a}
                    onCancel={() => setEditing(null)}
                    onClear={() => { setAdj((s) => { const n = { ...s }; delete n[r.name]; return n; }); setEditing(null); }}
                    onApply={(next) => {
                      setAdj((s) => ({ ...s, [r.name]: next }));
                      setEditing(null);
                      showToast(`${r.name} set to ${next.qty} (${next.mode === "perm" ? "permanent" : `resets after ${next.to || "the end date"}`}) — saving to the profile is the next build phase`);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <div className="e-t">Per-product plan is warming up for this store</div>
          <div className="e-b">The engine writes line-by-line ranging and orders for stores on a mature sales feed (Woolworths today). This store&apos;s totals are above; its product rows light up as its retailer feed fills the ledger.</div>
        </div>
      )}

      <div className="foot">
        This profile is the single source of truth — ranging, service level and adjustments set here propagate everywhere, with the shelf cap enforced and a warning on anything over it. <b>Editing is live in this build;</b> writing changes back to the store record is the next phase.
      </div>

      {toast && <div className="toast">{toast}</div>}

      <style>{`
      .sprof{display:block;padding-bottom:40px}
      .sprof .hero{display:flex;align-items:flex-start;gap:16px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:20px 24px;margin-bottom:14px;flex-wrap:wrap}
      .sprof .hero-l{flex:1;min-width:220px}
      .sprof .nm{font-family:var(--serif);font-size:24px;font-weight:600;letter-spacing:-.3px}
      .sprof .sub{display:flex;align-items:center;gap:9px;margin-top:9px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
      .sprof .chip{background:#efe6d3;color:var(--ink2);border-radius:999px;font-size:11.5px;font-weight:700;padding:3px 10px}
      .sprof .chip.soft{background:var(--line2);color:var(--faint)}
      .sprof .reg{color:var(--ink2);font-weight:600}
      .sprof .rtl{margin-left:auto;color:var(--faint);text-transform:capitalize}
      .sprof .scorebadge{display:flex;align-items:center;gap:10px;border-radius:12px;padding:10px 14px;border:1px solid var(--line)}
      .sprof .scorebadge.g{background:var(--green-b)}.sprof .scorebadge.a{background:var(--amber-b)}.sprof .scorebadge.r{background:var(--red-b)}
      .sprof .scorebadge .sd{font-size:16px}
      .sprof .scorebadge .st{font-weight:700;font-size:13.5px;line-height:1.2;color:var(--ink)}
      .sprof .scorebadge .st small{display:block;font-weight:500;font-size:10.5px;color:var(--ink2);opacity:.75;margin-top:2px}
      .sprof .mgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:12px;overflow:hidden}
      @media(max-width:760px){.sprof .mgrid{grid-template-columns:repeat(2,1fr)}}
      .sprof .m{background:var(--card);padding:13px 15px}
      .sprof .mv{font-family:var(--serif);font-size:22px;font-weight:600;letter-spacing:-.4px;font-variant-numeric:tabular-nums;line-height:1}
      .sprof .mv.g{color:var(--green-t)}.sprof .mv.a{color:var(--amber-t)}.sprof .mv.r{color:var(--red-t)}
      .sprof .mv.soft{color:var(--faint);font-weight:500}
      .sprof .ml{font-size:11px;color:var(--muted);margin-top:6px}
      .sprof .softnote{font-size:11.5px;color:var(--faint);line-height:1.5;margin:8px 2px 18px}
      .sprof .chartcard{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px;margin-bottom:16px}
      .sprof .cc-h{font-size:12.5px;color:var(--ink2);font-weight:600;margin-bottom:10px}
      .sprof .cc-h span{color:var(--muted);font-weight:400;margin-left:6px}
      .sprof .cc-leg{display:flex;gap:16px;font-size:11.5px;color:var(--ink2);margin-top:8px}
      .sprof .cc-leg i{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:-1px}
      .sprof .dialrow{display:flex;align-items:center;gap:18px;background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:14px 18px;margin-bottom:18px;flex-wrap:wrap}
      .sprof .dial-l{flex:1;min-width:240px}
      .sprof .dl-t{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);font-weight:700}
      .sprof .dl-s{font-size:12.5px;color:var(--ink2);margin-top:4px;line-height:1.5;max-width:520px}
      .sprof .seg{display:flex;background:#ece3d1;border-radius:10px;padding:3px;gap:3px}
      .sprof .seg button{border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);padding:9px 16px;border-radius:8px;cursor:pointer;transition:.15s}
      .sprof .seg button:hover{color:var(--ink2)}
      .sprof .seg button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(60,45,30,.16)}
      .sprof .seg button small{display:block;font-size:10px;font-weight:600;color:var(--green-t);margin-top:1px}
      .sprof .ph{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}
      .sprof .ph-t{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);font-weight:700;display:flex;align-items:center;gap:10px}
      .sprof .ph-t .cnt{background:#efe6d3;color:var(--ink2);border-radius:999px;font-size:11px;letter-spacing:0;padding:2px 9px;font-weight:700}
      .sprof .ph-cap{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums}
      .sprof .ph-cap .ok{color:var(--green-t)}.sprof .ph-cap .over{color:var(--red-t)}.sprof .ph-cap .soft{color:var(--faint);font-weight:500}
      .sprof .capwarn{background:var(--red-b);border:1px solid #eab9a8;color:var(--red-t);border-radius:11px;padding:11px 15px;font-size:13px;line-height:1.5;margin-bottom:14px}
      .sprof .capwarn b{color:var(--red-t)}
      .sprof .sheet{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
      .sprof .grid{display:grid;grid-template-columns:78px minmax(160px,1fr) 74px 74px 120px 92px;align-items:center}
      .sprof .colhead{background:var(--surface);border-bottom:1px solid var(--line)}
      .sprof .colhead .grid>div{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:11px 16px}
      .sprof .r{text-align:right}.sprof .c{text-align:center}
      .sprof .soft{color:var(--faint)}
      .sprof .row{border-top:1px solid var(--line2);transition:background .12s}
      .sprof .row:hover{background:#faf6ee}
      .sprof .row.off{background:#faf7f1}
      .sprof .row.off .pn{color:var(--faint)}
      .sprof .row>.grid>div{padding:12px 16px}
      .sprof .pn{font-weight:600;letter-spacing:-.1px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
      .sprof .notr{font-size:10.5px;font-weight:600;color:var(--amber-t);background:var(--amber-b);border-radius:999px;padding:2px 8px}
      .sprof .apill{font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 8px}
      .sprof .apill.perm{color:var(--crust-deep);background:#f0e2cc}
      .sprof .apill.temp{color:var(--amber-t);background:var(--amber-b)}
      .sprof .fd{font-weight:700;font-variant-numeric:tabular-nums}
      .sprof .sw{width:38px;height:22px;border-radius:999px;border:1px solid var(--line);background:#e7ddca;position:relative;cursor:pointer;transition:.15s;padding:0}
      .sprof .sw.on{background:var(--green);border-color:var(--green)}
      .sprof .sw .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
      .sprof .sw.on .knob{left:18px}
      .sprof .adjbtn{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit}
      .sprof .adjbtn:hover{border-color:var(--crust);color:var(--ink)}
      .sprof .editor{border-top:1px dashed var(--line);background:var(--surface);padding:14px 16px;display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}
      .sprof .editor .fld{display:flex;flex-direction:column;gap:5px}
      .sprof .editor label{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:700}
      .sprof .editor .step{display:inline-flex;align-items:center;gap:8px}
      .sprof .editor .step button{width:28px;height:28px;border:1px solid var(--line);background:var(--card);border-radius:7px;font-size:16px;cursor:pointer;color:var(--ink2);font-family:inherit}
      .sprof .editor .step input{width:64px;text-align:center;border:1px solid var(--line);border-radius:7px;padding:6px;font-size:15px;font-weight:700;font-family:inherit;font-variant-numeric:tabular-nums}
      .sprof .editor .modes{display:inline-flex;gap:6px}
      .sprof .editor .mode{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit}
      .sprof .editor .mode.on{background:var(--espresso);border-color:var(--espresso);color:#f4ecdc}
      .sprof .editor input[type=date]{border:1px solid var(--line);border-radius:7px;padding:6px 8px;font-family:inherit;font-size:12.5px;color:var(--ink)}
      .sprof .editor .sp{margin-left:auto;display:flex;gap:8px}
      .sprof .editor .apply{background:var(--espresso);border:1px solid var(--espresso);color:#f4ecdc;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
      .sprof .editor .ghost{background:transparent;border:1px solid var(--line);color:var(--ink2);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
      .sprof .editor .clear{background:transparent;border:none;color:var(--red-t);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
      .sprof .empty{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:22px 24px}
      .sprof .empty .e-t{font-family:var(--serif);font-size:17px;margin-bottom:6px}
      .sprof .empty .e-b{color:var(--ink2);max-width:640px;line-height:1.6}
      .sprof .foot{margin-top:20px;font-size:11.5px;color:var(--faint);line-height:1.6}
      .sprof .foot b{color:var(--ink2);font-weight:600}
      .sprof .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13px;font-weight:500;z-index:60;max-width:88vw}
      @media(max-width:760px){.sprof .grid{grid-template-columns:60px minmax(120px,1fr) 60px 96px 76px}.sprof .grid .soft{display:none}}
      `}</style>
    </section>
  );
}

function AdjustEditor({
  row,
  current,
  onApply,
  onCancel,
  onClear,
}: {
  row: Row;
  current?: Adj;
  onApply: (a: Adj) => void;
  onCancel: () => void;
  onClear: () => void;
}) {
  const [qty, setQty] = useState(current?.qty ?? row.rec);
  const [mode, setMode] = useState<"perm" | "temp">(current?.mode ?? "perm");
  const [from, setFrom] = useState(current?.from ?? "");
  const [to, setTo] = useState(current?.to ?? "");

  return (
    <div className="editor">
      <div className="fld">
        <label>Final delivery</label>
        <span className="step">
          <button type="button" onClick={() => setQty((q) => Math.max(0, q - 1))}>−</button>
          <input value={qty} inputMode="numeric" onChange={(e) => setQty(Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0))} />
          <button type="button" onClick={() => setQty((q) => q + 1)}>+</button>
        </span>
      </div>
      <div className="fld">
        <label>Type</label>
        <span className="modes">
          <button type="button" className={`mode ${mode === "perm" ? "on" : ""}`} onClick={() => setMode("perm")}>Permanent</button>
          <button type="button" className={`mode ${mode === "temp" ? "on" : ""}`} onClick={() => setMode("temp")}>Temporary</button>
        </span>
      </div>
      {mode === "temp" && (
        <>
          <div className="fld"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="fld"><label>Until (auto-resets)</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </>
      )}
      <div className="sp">
        {current && <button type="button" className="clear" onClick={onClear}>Remove</button>}
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="apply" onClick={() => onApply({ qty, mode, from: from || undefined, to: to || undefined })}>Apply</button>
      </div>
    </div>
  );
}
